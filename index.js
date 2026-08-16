/**
 * ============================================================
 *  개미데이터 - 국내주식 실시간 지표 백엔드 (Cloud Run Functions)
 * ============================================================
 *
 *  이 파일 하나로 완전히 독립 배포 가능합니다 (경제한장 코드 없음).
 *  Google Cloud Console → Cloud Run → 서비스 만들기 → "함수"
 *  → 인라인 편집기 → 이 파일 + package.json 붙여넣기 → 배포.
 *
 *  필요한 시크릿(Secret Manager): KIS_APP_KEY, KIS_APP_SECRET
 *  (환율 API 키는 이 프로젝트엔 필요 없음)
 *
 *  함수 진입점: getAntData
 * ============================================================
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors')({ origin: true });
const fs = require('fs');
const path = require('path');

admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true }); // undefined 필드가 있어도 에러 없이 무시하고 저장

const KIS_APP_KEY = defineSecret('KIS_APP_KEY');
const KIS_APP_SECRET = defineSecret('KIS_APP_SECRET');

const DOMAIN_REAL = 'https://openapi.koreainvestment.com:9443';
const DOMAIN_VIRTUAL = 'https://openapivts.koreainvestment.com:29443';
const BASE_URL = DOMAIN_REAL; // 모의투자 계좌면 DOMAIN_VIRTUAL 로 변경

// ⚠️ 2026-07-14부로 이 상수는 더 이상 안 씀 — 캐시 신선도는 Cloud Scheduler의 refreshAntData 호출 주기(권장 1분)로 결정됨.
// eslint-disable-next-line no-unused-vars
const CACHE_TTL_MS = 60 * 1000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function todayKST() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// 주말·공휴일 등으로 특정 날짜에 데이터가 없을 때, 하루씩 뒤로 가며 재계산하기 위한 헬퍼
function dateOffsetKST(daysAgo) {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  kst.setDate(kst.getDate() - daysAgo);
  const y = kst.getFullYear();
  const m = String(kst.getMonth() + 1).padStart(2, '0');
  const d = String(kst.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// ------------------------------------------------------------
// 접근토큰 발급 + Firestore 캐싱 (재발급 1분 1회 제한 보호용, 필수)
// ------------------------------------------------------------
async function getAccessToken(appKey, appSecret, forceRefresh = false) {
  const tokenDoc = db.collection('system').doc('kis_token');
  const now = Date.now();

  if (!forceRefresh) {
    const snap = await tokenDoc.get();
    if (snap.exists) {
      const data = snap.data();
      if (data.expiresAt && now < data.expiresAt - 10 * 60 * 1000) {
        return data.accessToken;
      }
    }
  }

  const res = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
    grant_type: 'client_credentials',
    appkey: appKey,
    appsecret: appSecret,
  }, { headers: { 'content-type': 'application/json' } });

  const { access_token, expires_in } = res.data;
  await tokenDoc.set({ accessToken: access_token, expiresAt: now + expires_in * 1000, issuedAt: now });
  return access_token;
}

async function callKisApi({ path, trId, params, appKey, appSecret, token }) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    params,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: 'P',
    },
  });
  return res.data;
}

// ------------------------------------------------------------
// ETF/ETN 판별 (KIS API가 별도 구분 플래그를 주지 않아 이름/코드 기반 추정)
// - 종목코드에 문자가 섞여있으면(신형 단일종목 레버리지/인버스 상품 등) 제외
// - 이름이 흔한 ETF/ETN 브랜드로 시작하거나 레버리지·인버스·선물·ETN 키워드 포함 시 제외
// - 100% 완벽하지 않을 수 있음 (브랜드 목록에 없는 낯선 ETF가 섞여 나오면 목록에 추가 필요)
// ------------------------------------------------------------
const ETF_ETN_NAME_PATTERN = /(레버리지|인버스|선물|ETN|KIWOOM|KoAct|KODEX|TIGER|KBSTAR|ARIRANG|SOL|HANARO|KOSEF|PLUS|WOORI|TIMEFOLIO|히어로즈|마이다스|ACE|FOCUS|네비게이터|마이티|파워|iSelect|RISE|1Q|UNICORN|WON|MIDAS|TIME|파인만|VITA|흥국|그로우|GROW|KINDEX)/;
function isRegularStock(r) {
  const name = r.hts_kor_isnm ?? '';
  const code = r.mksc_shrn_iscd ?? r.stck_shrn_iscd ?? '';
  if (/[^0-9]/.test(code)) return false;
  if (ETF_ETN_NAME_PATTERN.test(name)) return false;
  return true;
}

// ------------------------------------------------------------
// 종목조건검색(HTS [0110]에서 사용자가 직접 만들어 서버저장한 조건)을 활용한 TOP100 데이터
// - KIS 순위분석 API들은 대부분 최대 30건 제한이 있어서, 100건까지 필요한 항목은
//   이 조건검색 API로 대체 수집함 (HTS에서 "정렬 + 상위 100건" 설정을 미리 해둬야 함)
// - 응답 필드가 공통(종목코드/현재가/등락률/거래량/거래대금/시가총액)이라 공매도/신용잔고처럼
//   특수 지표(비중, 순매수금액 등)는 여기서 얻을 수 없음 — 순매수/매도는 "종목 목록"으로만 활용
// ------------------------------------------------------------
const HTS_USER_ID = 'okpika'; // 조건검색 API 호출용 HTS 로그인 아이디 (비밀번호 아님, 조건검색 API 전용 파라미터)
const CONDITION_SEQ = {
  volume: '0',
  up: '3',
  cap: '4',
  down: '7',
};
// ⚠️ 기관/외국인 순매수·순매도(구 instBuy/instSell/foreignSell/foreignBuy, seq 1/2/5/6)는
//    2026-07-14부로 폐기 — 조건검색(HHKST03900400) 방식은 "순매수 금액" 필드 자체가 없어서
//    검증이 불가능했고, HTS 조건 정렬 기준이 실제로 금액순인지 확인할 방법도 없었음.
//    아래 FOREIGN_INSTITUTION_TOTAL_TR_ID(국내주식-037, 정식 API)로 완전히 교체함.

// ------------------------------------------------------------
// 국내기관_외국인 매매종목가집계 (국내주식-037, 정식 API — 조건검색 우회 방식 대체용)
// ⚠️ 중요: 이 API는 실시간 자동계산이 아니라 "증권사 직원이 장중 특정 시각에 수기로 집계 입력"하는 값임
//    (공식 문서 명시) — 입력시각: 외국인 09:30/11:20/13:20/14:30, 기관종합 10:00/11:20/13:20/14:30
//    (±10분 오차 가능, 장운영 사정에 따라 변동/누락 가능). 즉 이 시각 사이엔 값이 그대로인 게 정상.
// 응답에 금액 필드(frgn_ntby_tr_pbmn, orgn_ntby_tr_pbmn, 단위 백만원)가 있어 금액순 검증 가능.
// ------------------------------------------------------------
const FOREIGN_INSTITUTION_TOTAL_TR_ID = 'FHPTJ04400000';
function extractOutputArray(raw) {
  const out = raw?.output;
  if (Array.isArray(out)) return out;
  if (out && typeof out === 'object') return [out]; // 혹시 종목이 1개뿐이거나 문서와 달리 단일 객체로 오는 경우 대비
  return [];
}

// 순위·금액(V API)은 그대로 두고, 현재가/등락률/등락금액만 별도 조회한 통합시세(UN)로 교체
function applyPriceOverride(rows, priceOverrideMap) {
  if (!priceOverrideMap) return rows;
  return rows.map((r) => {
    const o = priceOverrideMap[r.code];
    if (!o) return r; // 못 가져온 경우 원래 값(V API 시세) 유지 — 값이 아예 없어지는 것보단 나음
    return { ...r, price: o.price, change: o.change, changePct: o.changePct };
  });
}

// 개별 종목 현재가를 동시성 제한(3개씩)으로 조회 — 순차(1개씩)보다 약 3배 빠름
// call() 자체에 호출 하나당 150ms 딜레이가 이미 있어서, 동시 3개면 초당 대략 20건 안팎으로 KIS 호출 제한 안전선 안에서 처리됨
// (동시 개수를 더 늘리면 빨라지긴 하지만 순간적으로 몰리는 호출이 많아져 rate limit에 걸릴 위험이 커짐 → 3으로 보수적으로 설정)
// 신용잔고 TOP 종목의 시가총액을 하루에 한 번만 KIS에서 받아와 캐시함.
// ⚠️ 원래 매분 도는 refreshAntData 안에서 매번 새로 조회했더니, 다른 API 호출들과 겹치면서
//    초당 호출 제한(EGW00201)에 걸려 대부분 실패하는 문제가 있었음 (2026-08).
//    신용잔고 자체가 하루 한 번만 바뀌는 데이터라 어차피 매분 새로 조회할 이유가 없어서,
//    당일 최초 1회만 KIS를 호출하고 이후엔 Firestore 캐시를 재사용하도록 변경.
async function fetchCreditMarketCaps(codes, call) {
  const today = todayKST(); // 'YYYYMMDD'
  const cacheRef = db.collection('system').doc('creditMarketCapCache');
  const snap = await cacheRef.get();
  const cached = snap.exists ? snap.data() : null;
  const cachedMap = (cached && cached.date === today) ? (cached.map || {}) : {};

  const missingCodes = codes.filter((c) => !cachedMap[c]);
  if (missingCodes.length === 0) return cachedMap; // 오늘 이미 다 받아뒀으면 KIS 호출 없이 바로 반환

  const freshMap = await fetchPricesConcurrently(missingCodes, call);
  const mergedMap = { ...cachedMap, ...freshMap };
  await cacheRef.set({ date: today, map: mergedMap });
  return mergedMap;
}

async function fetchPricesConcurrently(codes, call) {
  const CONCURRENCY = 3;
  const priceOverrideMap = {};
  let cursor = 0;
  async function worker() {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      const res = await call('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
        FID_COND_MRKT_DIV_CODE: 'UN', FID_INPUT_ISCD: code,
      });
      const o = res?.output;
      if (o?.stck_prpr) {
        priceOverrideMap[code] = {
          price: Number(o.stck_prpr), change: computeChangeAmount(o), changePct: Number(o.prdy_ctrt),
          // hts_avls = HTS 시가총액(억원 단위) — 공식 API 문서(주식현재가 시세, 국내주식-008)로 필드명·단위 검증 완료 (2026-08)
          marketCap: o.hts_avls != null && o.hts_avls !== '' ? Number(o.hts_avls) : null,
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker));
  return priceOverrideMap;
}

function mapForeignInstTotalRow(row) {
  const price = Number(row.stck_prpr);
  const changePct = Number(row.prdy_ctrt);
  const changeSign = Number(row.prdy_vrss_sign); // 1,2:상한/상승 4,5:하한/하락 3:보합
  const changeAbs = Number(row.prdy_vrss);
  const change = (changeSign === 4 || changeSign === 5) ? -Math.abs(changeAbs) : Math.abs(changeAbs);
  return {
    code: row.mksc_shrn_iscd,
    name: row.hts_kor_isnm,
    price,
    change,
    changePct,
    volume: Number(row.acml_vol),
    netBuyQty: Number(row.ntby_qty),
    // 단위: 백만원 (문서 명시) — 프론트는 아직 안 씀, 검증/추후 표시용으로 남겨둠
    foreignNetBuyAmount: Number(row.frgn_ntby_tr_pbmn),
    institutionNetBuyAmount: Number(row.orgn_ntby_tr_pbmn),
  };
}

function isRegularStockCS(row) {
  const name = row.name ?? '';
  const code = row.code ?? '';
  if (/[^0-9]/.test(code)) return false;
  if (ETF_ETN_NAME_PATTERN.test(name)) return false;
  return true;
}

function mapConditionRow(row) {
  const price = Number(row.price);
  const changePct = Number(row.chgrate); // 등락률 (원본 필드명: chgrate)
  const volume = Number(row.acml_vol);   // 거래량 (원본 필드명: acml_vol)
  const marketCap = Number(row.stotprice); // 시가총액, 억원 단위로 추정 (원본 필드명: stotprice)
  // 이 API의 change(전일대비) 필드는 신뢰도가 낮아 보여서, 현재가·등락률로 역산 (다른 곳과 동일한 방식)
  const hasCalc = !isNaN(price) && !isNaN(changePct) && (1 + changePct / 100) !== 0;
  const change = hasCalc ? Math.round(price - price / (1 + changePct / 100)) : null;
  return { code: row.code, name: row.name, price, change, changePct, volume, marketCap };
}

function dedupeByCode(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const code = r.mksc_shrn_iscd ?? r.stck_shrn_iscd ?? r.hts_kor_isnm;
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

// ------------------------------------------------------------
// 실제 시세 데이터 수집
// 참고 메뉴 위치 (https://apiportal.koreainvestment.com/apiservice-apiservice):
//   지수                    → [국내주식] 업종/기타 > 국내업종 일자별지수 (FHPUP02120000)
//   코스피/코스닥 수급        → [국내주식] 시세분석 > 시장별 투자자매매동향(시세) (v1_국내주식-074, FHPTJ04030000)
//   거래량 상위              → [국내주식] 순위분석 > 거래량순위 (v1_국내주식-047, FHPST01710000)
//   등락률(상승/하락) 순위    → [국내주식] 순위분석 > 국내주식 등락률 순위 (v1_국내주식-088, FHPST01700000)
//   공매도 상위              → [국내주식] 순위분석 > 국내주식 공매도 상위종목 (국내주식-133, FHPST04820000)
//   신용잔고 상위            → [국내주식] 순위분석 > 국내주식 신용잔고 상위 (국내주식-109, FHKST17010000)
//   시가총액 상위            → [국내주식] 순위분석 > 국내주식 시가총액 상위 (v1_국내주식-091, FHPST01740000)
//     ⚠️ 시가총액 API는 문서에 "최대 30건, 다음 조회 불가"라고 명시되어 있음 → TOP50 요청 시 TOP30으로 조정 필요
//   신용잔고 시장 전체 합계  → [국내주식] 시세분석 > 국내 증시자금 종합 (국내주식-193, FHKST649100C0)
//     종목코드 없이 날짜만 넣으면 시장 전체 신용융자잔고/고객예탁금/미수금 등을 날짜별로 줌 (응답은 최신순 배열)
// 공식 GitHub(Python 샘플, LLM 참고용 공식 repo): https://github.com/koreainvestment/open-trading-api
// ------------------------------------------------------------
function createKisCaller(appKey, appSecret, initialToken) {
  let currentToken = initialToken; // KIS가 새 토큰 발급 시 기존 토큰을 즉시 무효화하는 경우가 있어, 캐시된 토큰이 "만료됨" 응답을 받으면 여기서 갱신해서 이후 모든 호출에 공유함
  return async (path, trId, params) => {
    await sleep(150); // KIS API 초당 호출 제한 방지용 딜레이
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callKisApi({ path, trId, params, appKey, appSecret, token: currentToken });
      } catch (err) {
        const isExpiredToken = err.response?.data?.msg_cd === 'EGW00123';
        if (isExpiredToken && attempt === 0) {
          console.error(`[개미데이터] 토큰 만료 감지 → 새 토큰 발급 후 재시도: ${path}`);
          currentToken = await getAccessToken(appKey, appSecret, true); // 강제 재발급
          continue;
        }
        if (attempt === 0) { await sleep(500); continue; } // 1회 재시도
        console.error(`[개미데이터] KIS API 호출 실패: ${path} (${trId}) params=${JSON.stringify(params)} →`, err.response?.data || err.message);
        return null;
      }
    }
  };
}

function ymdToDate(ymd) { // 'YYYYMMDD' -> Date
  return new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}T00:00:00+09:00`);
}
function dateToYmd(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}${m}${day}`;
}

// 신용잔고/예탁금/미수금 최장 5년치 추이 — mktfunds(국내주식-193)는 tr_cont(연속조회)를 지원 안 해서
// 한 번 호출에 약 100영업일(5개월가량)만 나옴 → 기준일(FID_INPUT_DATE_1)을 계속 과거로 옮겨가며 반복 호출해서 이어붙임.
// 5년 = 약 1,250영업일 ÷ 100 ≈ 13번 호출. 매분 도는 refreshAntData가 아니라 하루 1번 도는 refreshCreditTrend 전용.
async function fetchCreditTrendHistory(appKey, appSecret, token) {
  const call = createKisCaller(appKey, appSecret, token);
  const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - FIVE_YEARS_MS;
  const byDate = new Map(); // bsop_date -> row (중복 제거용)
  let anchor = todayKST();
  for (let i = 0; i < 15; i++) { // 안전장치로 최대 15회만 (5년치+여유분)
    const res = await call('/uapi/domestic-stock/v1/quotations/mktfunds', 'FHKST649100C0', { FID_INPUT_DATE_1: anchor });
    const rows = res?.output ?? [];
    if (rows.length === 0) break; // 더 이상 과거 데이터가 없음 (상장 초기 등)
    let minDate = anchor;
    for (const r of rows) {
      if (!r.bsop_date) continue;
      if (r.bsop_date < minDate) minDate = r.bsop_date;
      if (!byDate.has(r.bsop_date)) {
        byDate.set(r.bsop_date, {
          date: r.bsop_date,
          creditLoanBalance: Number(r.crdt_loan_rmnd), // 억원
          custDeposit: Number(r.cust_dpmn_amt), // 억원
          unsettledAmt: Number(r.uncl_amt), // 억원
        });
      }
    }
    if (ymdToDate(minDate).getTime() <= cutoff) break; // 5년 지점까지 확보했으면 그만
    const nextAnchorDate = ymdToDate(minDate);
    nextAnchorDate.setDate(nextAnchorDate.getDate() - 1); // 겹치지 않게 하루 더 과거로
    const nextAnchor = dateToYmd(nextAnchorDate);
    if (nextAnchor === anchor) break; // 혹시 모를 무한루프 방지
    anchor = nextAnchor;
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)); // 오래된 순으로 정렬
}

async function fetchAntDataSnapshot(appKey, appSecret, initialToken) {
  const call = createKisCaller(appKey, appSecret, initialToken);

  const todayStr = todayKST();

  // 지수 (코스피/코스닥)
  const kospi = await call('/uapi/domestic-stock/v1/quotations/inquire-index-daily-price', 'FHPUP02120000', {
    FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001', FID_INPUT_DATE_1: todayStr, FID_PERIOD_DIV_CODE: 'D',
  });
  const kosdaq = await call('/uapi/domestic-stock/v1/quotations/inquire-index-daily-price', 'FHPUP02120000', {
    FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '1001', FID_INPUT_DATE_1: todayStr, FID_PERIOD_DIV_CODE: 'D',
  });

  // 코스피/코스닥 시장별 투자자매매동향(시세) - 개인/외국인/기관 수급
  // ⚠️ 중요: 파라미터는 반드시 대문자(FID_INPUT_ISCD)여야 함 (소문자로 하면 응답이 옴에도 값이 안 채워짐)
  // ⚠️ 중요: 응답 output은 문서엔 객체(object)라 되어있지만 실제로는 배열(array) 안에 객체 1개가 들어있음 → pickFlow()에서 처리
  const kospiFlow = await call('/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market', 'FHPTJ04030000', {
    FID_INPUT_ISCD: 'KSP', FID_INPUT_ISCD_2: '0001',
  });
  const kosdaqFlow = await call('/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market', 'FHPTJ04030000', {
    FID_INPUT_ISCD: 'KSQ', FID_INPUT_ISCD_2: '1001',
  });

  // 공매도 상위 - ⚠️ NX 지원 여부 미확인 → 다음 세션에서 검증 필요
  const shortSaleTop = await call('/uapi/domestic-stock/v1/ranking/short-sale', 'FHPST04820000', {
    FID_APLY_RANG_VOL: '', FID_COND_MRKT_DIV_CODE: 'UN', FID_COND_SCR_DIV_CODE: '20482',
    FID_INPUT_ISCD: '0000', FID_PERIOD_DIV_CODE: 'D', FID_INPUT_CNT_1: '0',
    FID_TRGT_EXLS_CLS_CODE: '', FID_TRGT_CLS_CODE: '', FID_APLY_RANG_PRC_1: '', FID_APLY_RANG_PRC_2: '',
  });

  // 신용잔고 상위 - ⚠️ NX 지원 여부 미확인 → 다음 세션에서 검증 필요
  const creditBalanceTop = await call('/uapi/domestic-stock/v1/ranking/credit-balance', 'FHKST17010000', {
    FID_COND_SCR_DIV_CODE: '11701', FID_INPUT_ISCD: '0000', FID_OPTION: '2',
    FID_COND_MRKT_DIV_CODE: 'UN', FID_RANK_SORT_CLS_CODE: '2',
  });

  // 신용잔고 TOP 종목들의 실시간 현재가·시가총액 별도 조회 (2026-08 추가)
  // — "신용잔고비율(주식수 기준)"과는 별개로, "시총 대비 신용잔고금액" 비율을 함께 보여주기 위함.
  // 신용잔고 API 자체엔 시가총액이 안 들어있어서, 종목별 시세 조회(inquire-price)로 따로 받아옴.
  const creditCodes = dedupeByCode(creditBalanceTop?.output2 ?? []).filter(isRegularStock).map((r) => r.mksc_shrn_iscd);
  const creditPriceOverrideMap = await fetchCreditMarketCaps(creditCodes, call);

  // 국내 증시자금 종합 - 시장 전체 신용융자잔고/고객예탁금/미수금 (종목 단위 아님, 시장 전체 합계)
  // 응답 output은 날짜 내림차순 배열(최신이 [0])이라, [0]-[1] 차이로 전일대비를 직접 계산해야 함
  // ⚠️ 이 API는 "정확히 요청한 날짜"의 데이터만 주는 방식이라, 주말·공휴일처럼 그날 데이터가
  //    아예 없는 날을 넣으면 output이 텅 빈 채로 옴. 그래서 오늘 날짜부터 최대 7일 전까지
  //    하루씩 뒤로 가면서 실제로 데이터가 나오는 날을 찾을 때까지 재시도함.
  let marketFunds = null;
  for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
    const tryDate = daysAgo === 0 ? todayStr : dateOffsetKST(daysAgo);
    try {
      const attempt = await call('/uapi/domestic-stock/v1/quotations/mktfunds', 'FHKST649100C0', {
        FID_INPUT_DATE_1: tryDate,
      });
      if (Array.isArray(attempt?.output) && attempt.output.length > 0) {
        marketFunds = attempt;
        break;
      }
    } catch (e) {
      // 이 날짜 시도가 실패해도(일시적 오류 등) 포기하지 않고 다음 날짜로 계속 재시도함
      console.error(`mktfunds 조회 실패 (${tryDate}):`, e.message);
    }
  }

  // 종목조건검색 4종 (거래량/상승률/시가총액/하락률) — HTS [0110]에서 사용자가 미리 만들어 서버저장해둔 조건을 실행 (국내주식-039, HHKST03900400)
  // - 시가총액/거래량/상승률/하락률은 예전엔 순위분석 API(30건 상한)를 썼는데, 이제 이걸로 대체해서 100건까지 나옴
  // - 기관/외국인 순매수·순매도는 2026-07-14부로 이 방식에서 빠지고 정식 API(foreign-institution-total)로 교체됨 (아래 참고)
  const conditionResults = {};
  for (const [key, seq] of Object.entries(CONDITION_SEQ)) {
    const res = await call('/uapi/domestic-stock/v1/quotations/psearch-result', 'HHKST03900400', {
      user_id: HTS_USER_ID, seq,
    });
    conditionResults[key] = res?.output2 ?? [];
  }

  // 국내기관_외국인 매매종목가집계 (국내주식-037) — 외국인/기관 순매수·순매도 TOP, 금액정렬
  // FID_DIV_CLS_CODE: 1(금액정렬) / FID_RANK_SORT_CLS_CODE: 0(순매수상위) 1(순매도상위) / FID_ETC_CLS_CODE: 1(외국인) 2(기관계)
  // ⚠️ FID_COND_MRKT_DIV_CODE는 'UN'으로 바꿔봤다가 이 API 자체가 데이터를 안 줘서(전종목 응답 자체가 비어버림) 'V'로 원복함.
  //   순위·금액은 이 API(V) 그대로 쓰고, 현재가/등락률/등락금액만 아래에서 공매도가 쓰는 방식(inquire-price, UN)으로 따로 덮어씀.
  const foreignInstBase = {
    FID_COND_MRKT_DIV_CODE: 'V', FID_COND_SCR_DIV_CODE: '16449', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '1',
  };
  const foreignBuyTotal = await call('/uapi/domestic-stock/v1/quotations/foreign-institution-total', FOREIGN_INSTITUTION_TOTAL_TR_ID, {
    ...foreignInstBase, FID_RANK_SORT_CLS_CODE: '0', FID_ETC_CLS_CODE: '1',
  });
  const foreignSellTotal = await call('/uapi/domestic-stock/v1/quotations/foreign-institution-total', FOREIGN_INSTITUTION_TOTAL_TR_ID, {
    ...foreignInstBase, FID_RANK_SORT_CLS_CODE: '1', FID_ETC_CLS_CODE: '1',
  });
  const instBuyTotal = await call('/uapi/domestic-stock/v1/quotations/foreign-institution-total', FOREIGN_INSTITUTION_TOTAL_TR_ID, {
    ...foreignInstBase, FID_RANK_SORT_CLS_CODE: '0', FID_ETC_CLS_CODE: '2',
  });
  const instSellTotal = await call('/uapi/domestic-stock/v1/quotations/foreign-institution-total', FOREIGN_INSTITUTION_TOTAL_TR_ID, {
    ...foreignInstBase, FID_RANK_SORT_CLS_CODE: '1', FID_ETC_CLS_CODE: '2',
  });

  // 기관/외국인 TOP 리스트에 등장하는 종목들의 "실제" 현재가/등락률/등락금액을 별도 조회해서 덮어씌움
  // (foreign-institution-total 응답 자체의 stck_prpr 대신, 공매도 API와 같은 통합시세(UN) 기준 단일 종목 시세 API 사용)
  // ⚠️ 종목 수만큼 개별 호출이 늘어남 (call()에 150ms 딜레이 내장) — 응답 시간 길어지면 다음 세션에서 최적화 필요
  const matchedFlowCodes = new Set();
  for (const raw of [foreignBuyTotal, foreignSellTotal, instBuyTotal, instSellTotal]) {
    for (const row of extractOutputArray(raw)) {
      if (row?.mksc_shrn_iscd) matchedFlowCodes.add(row.mksc_shrn_iscd);
    }
  }
  const priceOverrideMap = await fetchPricesConcurrently([...matchedFlowCodes], call);

  return {
    kospi, kosdaq, kospiFlow, kosdaqFlow, shortSaleTop, creditBalanceTop, marketFunds, conditionResults,
    foreignBuyTotal, foreignSellTotal, instBuyTotal, instSellTotal, priceOverrideMap, creditPriceOverrideMap,
  };
}

function pickFlow(flowRaw) {
  // 문서에는 output이 객체(object)라고 되어있었지만, 실제 응답은 배열(array) 안에 객체 1개가 들어있는 구조였다.
  const raw = flowRaw?.output;
  const o = Array.isArray(raw) ? raw[0] : raw;
  if (!o || typeof o.frgn_ntby_qty === 'undefined') return null;
  return {
    foreign: { qty: o.frgn_ntby_qty ?? null, amount: o.frgn_ntby_tr_pbmn ?? null },
    individual: { qty: o.prsn_ntby_qty ?? null, amount: o.prsn_ntby_tr_pbmn ?? null },
    institution: { qty: o.orgn_ntby_qty ?? null, amount: o.orgn_ntby_tr_pbmn ?? null },
  };
}

// ------------------------------------------------------------
// 변동금액(전일대비 금액) 계산
// - KIS 응답에 prdy_vrss(전일대비, 보통 부호 없는 절대값) + prdy_vrss_sign(1상한/2상승/3보합/4하한/5하락)이
//   있으면 그걸로 부호를 정확히 결정
// - 혹시 필드명이 다르거나 없는 경우를 대비해, 현재가·등락률로 역산하는 fallback도 넣어둠
//   (역산은 반올림 특성상 실제 값과 1원 정도 오차가 날 수 있음 — 화면 표시용으로는 무방)
// ------------------------------------------------------------
function computeChangeAmount(r) {
  const raw = r.prdy_vrss;
  if (raw !== undefined && raw !== null && raw !== '') {
    const magnitude = Math.abs(Number(raw));
    if (!isNaN(magnitude)) {
      const sign = r.prdy_vrss_sign;
      if (sign === '4' || sign === '5') return -magnitude;
      if (sign === '1' || sign === '2') return magnitude;
      // 부호 필드가 없거나 예상 밖 값이면 등락률 부호를 따라감
      const pct = Number(r.prdy_ctrt);
      if (!isNaN(pct)) return pct < 0 ? -magnitude : magnitude;
      return magnitude;
    }
  }
  // prdy_vrss 필드 자체가 없을 때의 fallback: 현재가/등락률로 역산
  const price = Number(r.stck_prpr);
  const pct = Number(r.prdy_ctrt);
  if (isNaN(price) || isNaN(pct)) return null;
  const prevClose = price / (1 + pct / 100);
  return Math.round(price - prevClose);
}

function mapMarketCredit(marketFundsRaw) {
  const rows = marketFundsRaw?.output;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = rows[0]; // 응답이 날짜 내림차순이라 [0]이 최신
  const prevRow = rows[1];
  const latestVal = Number(latest.crdt_loan_rmnd); // 억원
  const prevVal = prevRow ? Number(prevRow.crdt_loan_rmnd) : NaN;
  const hasChange = !isNaN(latestVal) && !isNaN(prevVal) && prevVal !== 0;
  return {
    date: latest.bsop_date,
    creditLoanBalance: isNaN(latestVal) ? null : latestVal, // 억원
    change: hasChange ? Math.round(latestVal - prevVal) : null, // 억원
    changePct: hasChange ? ((latestVal - prevVal) / prevVal) * 100 : null,
    custDeposit: Number(latest.cust_dpmn_amt) || null, // 억원, 고객예탁금
    unsettledAmt: Number(latest.uncl_amt) || null, // 억원, 미수금
  };
}

// ------------------------------------------------------------
// 공매도 상위 / 신용잔고 상위 API 응답의 "기준일자" 추출
// - 공매도 상위(국내주식-133): 각 row에 stnd_date1/2가 있는데, 예시상 첫 row만 값이 차있고
//   나머지는 "0"으로 오는 경우가 있어 방어적으로 0이 아닌 첫 값을 찾음
// - 신용잔고 상위(국내주식-109): output1이라는 별도 요약 object에 stnd_date1(매매기준일),
//   stnd_date2(공표/집계기준일)가 있고, 실제로 2일 차이가 나는 경우가 있음(T+2 정산 구조로 추정)
// ------------------------------------------------------------
function extractShortSaleAsOf(shortSaleRaw) {
  const rows = shortSaleRaw?.output ?? [];
  const found = rows.find((r) => r.stnd_date1 && r.stnd_date1 !== '0');
  return found ? found.stnd_date1 : null;
}
function extractCreditAsOf(creditRaw) {
  const summary = creditRaw?.output1?.[0];
  if (!summary) return null;
  return {
    tradeDate: summary.stnd_date1 || null,   // 기준 일자1 (매매기준일로 추정)
    publishDate: summary.stnd_date2 || null, // 기준 일자2 (공표/집계기준일로 추정, 매매기준일보다 며칠 뒤인 경우 있음)
  };
}

function normalizeAntData(raw) {
  const mapVolumeRow = (r) => ({
    name: r.hts_kor_isnm, code: r.mksc_shrn_iscd, price: r.stck_prpr, change: computeChangeAmount(r), changePct: r.prdy_ctrt, volume: r.acml_vol,
  });
  const mapFluctRow = (r) => ({
    name: r.hts_kor_isnm, code: r.stck_shrn_iscd, price: r.stck_prpr, change: computeChangeAmount(r), changePct: r.prdy_ctrt, volume: r.acml_vol,
  });
  const mapShortSaleRow = (r) => ({
    name: r.hts_kor_isnm, code: r.mksc_shrn_iscd, price: r.stck_prpr, change: computeChangeAmount(r), changePct: r.prdy_ctrt,
    shortVolumeRatio: r.ssts_vol_rlim, // 당일 거래량 대비 공매도 비중(%)
    shortValue: r.ssts_tr_pbmn,        // 공매도 거래대금 (원 단위 — 검증 완료, 그대로 사용)
  });
  const creditPriceMap = raw.creditPriceOverrideMap || {};
  const mapCreditRow = (r) => {
    const override = creditPriceMap[r.mksc_shrn_iscd];
    const loanBalanceAmtWon = Number(r.whol_loan_rmnd_amt) * 10000; // 만원 → 원
    let marketCapBasedRate = null;
    if (override?.marketCap) {
      const marketCapWon = override.marketCap * 100000000; // 억원 → 원
      if (marketCapWon > 0) marketCapBasedRate = (loanBalanceAmtWon / marketCapWon) * 100;
    }
    return {
      name: r.hts_kor_isnm, code: r.mksc_shrn_iscd, price: r.stck_prpr, change: computeChangeAmount(r), changePct: r.prdy_ctrt,
      loanBalanceAmt: r.whol_loan_rmnd_amt, // ⚠️ 만원(10,000원) 단위! 원 단위 아님 (검증 완료) — 프론트에서 /10000 해서 억원 변환
      loanBalanceRate: r.whol_loan_rmnd_rate, // 신용잔고 비율(%) — 상장주식수 대비 (KRX 공식 정의)
      marketCapBasedRate, // 신용잔고금액 ÷ 실시간 시가총액 비율(%) — 참고용 보조 지표 (2026-08 추가), 시총 실시간 조회 실패 시 null
    };
  };
  const mapMarketCapRow = (r) => ({
    name: r.hts_kor_isnm, code: r.mksc_shrn_iscd, price: r.stck_prpr, change: computeChangeAmount(r), changePct: r.prdy_ctrt,
    marketCap: r.stck_avls, // 이미 억원 단위로 옴 (추가 변환 불필요, 검증 완료)
    weightPct: r.mrkt_whol_avls_rlim,
  });

  return {
    updatedAt: Date.now(),
    indices: {
      kospi: raw.kospi?.output1 ? {
        value: raw.kospi.output1.bstp_nmix_prpr, change: raw.kospi.output1.bstp_nmix_prdy_vrss,
        changePct: raw.kospi.output1.bstp_nmix_prdy_ctrt,
      } : null,
      kosdaq: raw.kosdaq?.output1 ? {
        value: raw.kosdaq.output1.bstp_nmix_prpr, change: raw.kosdaq.output1.bstp_nmix_prdy_vrss,
        changePct: raw.kosdaq.output1.bstp_nmix_prdy_ctrt,
      } : null,
    },
    flowByMarket: {
      kospi: pickFlow(raw.kospiFlow),
      kosdaq: pickFlow(raw.kosdaqFlow),
    },
    marketCredit: mapMarketCredit(raw.marketFunds), // 시장 전체 신용잔고 합계 (종목 순위 아님)
    dataAsOf: {
      shortSale: extractShortSaleAsOf(raw.shortSaleTop), // "YYYYMMDD" 또는 null
      creditBalance: extractCreditAsOf(raw.creditBalanceTop), // { tradeDate, publishDate } 또는 null
    },
    // 공매도/신용잔고는 여전히 KIS 순위분석 API(다음조회 불가, 최대 30건)를 써서 TOP30이 상한
    shortSaleTop: [...(raw.shortSaleTop?.output ?? [])]
      .filter(isRegularStock)
      .sort((a, b) => Number(b.ssts_vol_rlim) - Number(a.ssts_vol_rlim)) // 공매도 비중 기준 직접 정렬 (API 자체 순서를 신뢰하지 않음)
      .slice(0, 30).map(mapShortSaleRow),
    creditBalanceTop: dedupeByCode(raw.creditBalanceTop?.output2 ?? []) // API가 종목을 중복으로 주는 경우가 있어 중복 제거 필수
      .filter(isRegularStock)
      .sort((a, b) => Number(b.whol_loan_rmnd_rate) - Number(a.whol_loan_rmnd_rate))
      .slice(0, 30).map(mapCreditRow),
    // 아래는 종목조건검색(HTS에서 미리 만든 조건) 기반 TOP100 — 시가총액/거래량/등락률은 여기로 교체됨
    marketCapTop: (raw.conditionResults?.cap ?? []).filter(isRegularStockCS).slice(0, 50).map(mapConditionRow),
    volumeTop: (raw.conditionResults?.volume ?? []).filter(isRegularStockCS).slice(0, 50).map(mapConditionRow),
    fluctuationUpTop: (raw.conditionResults?.up ?? []).filter(isRegularStockCS).slice(0, 50).map(mapConditionRow),
    fluctuationDownTop: (raw.conditionResults?.down ?? []).filter(isRegularStockCS).slice(0, 50).map(mapConditionRow),
    // 신규(2026-07-14): 기관/외국인 순매수·순매도 — 정식 API(국내주식-037, foreign-institution-total)로 교체
    // (구 조건검색 방식은 금액 필드가 없어 검증 불가 + 정렬 기준 오류 있었음, 위 HANDOFF 참고)
    // ⚠️ 이 API는 실시간이 아니라 하루 4번(외국인 09:30/11:20/13:20/14:30, 기관 10:00/11:20/13:20/14:30)
    //    수기 집계 입력값 — 그 시각 사이엔 값이 그대로인 게 정상 동작임
    institutionBuyTop: applyPriceOverride(extractOutputArray(raw.instBuyTotal).map(mapForeignInstTotalRow).filter(isRegularStockCS).slice(0, 30), raw.priceOverrideMap),
    institutionSellTop: applyPriceOverride(extractOutputArray(raw.instSellTotal).map(mapForeignInstTotalRow).filter(isRegularStockCS).slice(0, 30), raw.priceOverrideMap),
    foreignBuyTop: applyPriceOverride(extractOutputArray(raw.foreignBuyTotal).map(mapForeignInstTotalRow).filter(isRegularStockCS).slice(0, 30), raw.priceOverrideMap),
    foreignSellTop: applyPriceOverride(extractOutputArray(raw.foreignSellTotal).map(mapForeignInstTotalRow).filter(isRegularStockCS).slice(0, 30), raw.priceOverrideMap),
  };
}

// 기관·외국인 "동시" 순매수/순매도 종목 — 두 리스트 모두에 있는 종목만 교집합으로 추출
// 정렬 기준: 기관금액+외국인금액 합산 절대값 큰 순 (얼마나 강하게 같은 방향으로 쏠렸는지)
function buildMatchedFlow(instList, foreignList) {
  const foreignByCode = new Map(foreignList.map((r) => [r.code, r]));
  const matched = [];
  for (const instRow of instList) {
    const foreignRow = foreignByCode.get(instRow.code);
    if (!foreignRow) continue;
    matched.push({
      code: instRow.code, name: instRow.name, price: instRow.price, change: instRow.change, changePct: instRow.changePct,
      institutionAmount: instRow.institutionNetBuyAmount, // 백만원
      foreignAmount: foreignRow.foreignNetBuyAmount,       // 백만원
    });
  }
  matched.sort((a, b) => (Math.abs(b.institutionAmount) + Math.abs(b.foreignAmount)) - (Math.abs(a.institutionAmount) + Math.abs(a.foreignAmount)));
  return matched;
}

function attachMatchedFlow(data) {
  data.matchedBuyTop = buildMatchedFlow(data.institutionBuyTop, data.foreignBuyTop);
  data.matchedSellTop = buildMatchedFlow(data.institutionSellTop, data.foreignSellTop);
  return data;
}

// ------------------------------------------------------------
// 사용자용 API - 프론트엔드가 페이지를 열 때마다 이 URL로 fetch() 호출
//   ⚠️ 2026-07-14부로 구조 변경: 여기서는 절대 KIS를 직접 호출하지 않음 — 무조건 캐시(Firestore)만 보고 즉시 응답.
//   실제 데이터 갱신은 아래 refreshAntData가 Cloud Scheduler에 의해 별도로 주기 실행하며 담당함.
//   이렇게 분리한 이유: 기관/외국인 현재가 개별 조회(최대 100개)가 추가되면서 캐시 만료 직후 접속한
//   사용자가 그 무거운 계산을 통째로 기다려야 하는 문제(약 30초)가 생겼음 → 사용자 요청과 KIS 호출을 완전히 분리해서 해결.
// ------------------------------------------------------------
exports.getAntData = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const cacheDoc = db.collection('antData').doc('latest');
        const cacheSnap = await cacheDoc.get();
        if (cacheSnap.exists) {
          // 캐시가 60초보다 오래됐어도 그냥 그대로 반환함 (fresh 여부는 data.updatedAt 보고 프론트에서 판단 가능)
          // — 어차피 갱신은 refreshAntData가 스케줄러로 주기적으로 하고 있으므로, 여기서 KIS를 다시 호출할 필요가 없음
          res.status(200).json({ ok: true, cached: true, data: cacheSnap.data() });
          return;
        }
        // 캐시가 아예 없는 경우(최초 배포 직후 등)에 한해서만 예외적으로 직접 호출 — 이후엔 refreshAntData가 캐시를 채워줌
        const appKey = KIS_APP_KEY.value();
        const appSecret = KIS_APP_SECRET.value();
        const token = await getAccessToken(appKey, appSecret);
        const raw = await fetchAntDataSnapshot(appKey, appSecret, token);
        const data = attachMatchedFlow(normalizeAntData(raw));
        await cacheDoc.set(data);
        res.status(200).json({ ok: true, cached: false, data });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  }
);

// ------------------------------------------------------------
// 갱신 전용 함수 - 사용자가 직접 호출하는 게 아니라 Cloud Scheduler가 1분마다 호출해야 함
//   (Cloud Scheduler → HTTP 트리거 → 이 함수 URL, 예: https://.../refreshAntData, 매 1분)
//   실제 KIS 호출 + Firestore 캐시 저장을 여기서 전담. getAntData는 이 결과를 읽기만 함.
// ------------------------------------------------------------
exports.refreshAntData = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET], timeoutSeconds: 120 },
  async (req, res) => {
    try {
      const appKey = KIS_APP_KEY.value();
      const appSecret = KIS_APP_SECRET.value();
      const token = await getAccessToken(appKey, appSecret);
      const raw = await fetchAntDataSnapshot(appKey, appSecret, token);
      const data = attachMatchedFlow(normalizeAntData(raw));
      await db.collection('antData').doc('latest').set(data);

      // 기관/외국인 TOP5를 날짜별로 아카이브 — 블로그 썸네일용 날짜별 조회 페이지에서 사용
      // ⚠️ 매분 계속 덮어씀 (같은 날짜 문서를 반복 저장) → 장중엔 계속 갱신되다가 장 마감 이후 마지막 저장분이 그날의 최종치가 됨
      // 새 스케줄러 안 만들고 이미 도는 refreshAntData에 묻어가는 방식이라 추가 KIS 호출 없음
      const archiveDate = todayKST(); // 'YYYYMMDD'
      await db.collection('flowArchive').doc(archiveDate).set({
        date: archiveDate,
        updatedAt: data.updatedAt,
        institutionBuyTop5: (data.institutionBuyTop ?? []).slice(0, 5),
        institutionSellTop5: (data.institutionSellTop ?? []).slice(0, 5),
        foreignBuyTop5: (data.foreignBuyTop ?? []).slice(0, 5),
        foreignSellTop5: (data.foreignSellTop ?? []).slice(0, 5),
      });

      res.status(200).json({ ok: true, updatedAt: data.updatedAt });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ------------------------------------------------------------
// 기관/외국인 TOP5 날짜별 아카이브 조회 - 사용자용 API (블로그 썸네일 캡처 페이지에서 사용)
//   ?date=YYYYMMDD 파라미터 필수. 여기도 KIS를 직접 호출하지 않고 flowArchive 캐시만 읽음.
// ------------------------------------------------------------
exports.getFlowArchive = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const date = String(req.query.date || '').replace(/-/g, ''); // 'YYYY-MM-DD' or 'YYYYMMDD' 둘 다 허용
        if (!/^\d{8}$/.test(date)) {
          res.status(400).json({ ok: false, error: 'date 파라미터가 필요해요 (예: ?date=2026-07-16)' });
          return;
        }
        const snap = await db.collection('flowArchive').doc(date).get();
        if (!snap.exists) {
          res.status(404).json({ ok: false, error: `${date} 데이터가 아직 없어요 (아카이브 시작 이전이거나 휴장일일 수 있어요)` });
          return;
        }
        res.status(200).json({ ok: true, data: snap.data() });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  }
);

// ------------------------------------------------------------
// 신용잔고·예탁금·미수금 추이(30일/6개월/1년/5년 그래프용) - 사용자용 API
//   ⚠️ getAntData와 마찬가지로 여기서도 KIS를 직접 호출하지 않음 — 캐시(Firestore)만 읽어서 즉시 응답.
//   실제 갱신은 아래 refreshCreditTrend가 Cloud Scheduler(하루 1번, 장 마감 후 권장)로 전담.
// ------------------------------------------------------------
exports.getCreditTrend = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const cacheDoc = db.collection('creditTrend').doc('latest');
        const cacheSnap = await cacheDoc.get();
        if (cacheSnap.exists) {
          res.status(200).json({ ok: true, cached: true, data: cacheSnap.data() });
          return;
        }
        // 캐시가 아예 없는 최초 1회에 한해서만 직접 호출 (최대 15번 호출이라 시간이 좀 걸림)
        const appKey = KIS_APP_KEY.value();
        const appSecret = KIS_APP_SECRET.value();
        const token = await getAccessToken(appKey, appSecret);
        const series = await fetchCreditTrendHistory(appKey, appSecret, token);
        const data = { updatedAt: Date.now(), series };
        await cacheDoc.set(data);
        res.status(200).json({ ok: true, cached: false, data });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  }
);

// ------------------------------------------------------------
// 갱신 전용 함수 - Cloud Scheduler가 하루 1번(장 마감 후, 예: 평일 18:00) 호출해야 함
//   과거 데이터는 어차피 안 바뀌니 매분 돌 필요 없음 — refreshAntData(1분 주기)와는 완전히 별도 스케줄로 관리.
// ------------------------------------------------------------
exports.refreshCreditTrend = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET], timeoutSeconds: 180 },
  async (req, res) => {
    try {
      const appKey = KIS_APP_KEY.value();
      const appSecret = KIS_APP_SECRET.value();
      const token = await getAccessToken(appKey, appSecret);
      const series = await fetchCreditTrendHistory(appKey, appSecret, token);
      const data = { updatedAt: Date.now(), series };
      await db.collection('creditTrend').doc('latest').set(data);
      res.status(200).json({ ok: true, updatedAt: data.updatedAt, count: series.length });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ------------------------------------------------------------
// 진단용 함수 - 특정 종목의 공매도 "일별추이"를 그대로 확인하기 위한 임시 디버그용 엔드포인트
//   ([국내주식] 시세분석 > 국내주식 공매도 일별추이, 국내주식-134, FHPST04830000)
// 캐시 없이 매번 KIS를 직접 호출함 (진단 목적이라 60초 캐시 안 씀)
// 사용 예: /getShortSaleTrend?code=000660&from=20260706
// 확인 끝나면 지워도 되는 임시 엔드포인트임 (프로덕션 기능 아님)
// ------------------------------------------------------------
exports.getShortSaleTrend = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const appKey = KIS_APP_KEY.value();
        const appSecret = KIS_APP_SECRET.value();
        const token = await getAccessToken(appKey, appSecret);

        const stockCode = req.query.code || '000660'; // 기본값: SK하이닉스
        const dateFrom = req.query.from || '20260706';
        const dateTo = req.query.to || '';

        const result = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/daily-short-sale`, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'FHPST04830000',
            custtype: 'P',
          },
          params: {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: stockCode,
            FID_INPUT_DATE_1: dateFrom,
            FID_INPUT_DATE_2: dateTo,
          },
        });

        const rows = (result.data.output2 || [])
          .slice()
          .sort((a, b) => Number(a.stck_bsop_date) - Number(b.stck_bsop_date))
          .map((r) => ({
            date: r.stck_bsop_date,
            close: r.stck_clpr,
            shortQty: r.ssts_cntg_qty,
            shortRatio: r.ssts_vol_rlim,
            cumShortQty: r.acml_ssts_cntg_qty,
            approxValueEok: Math.round((Number(r.stck_clpr) * Number(r.ssts_cntg_qty)) / 1e8),
          }));

        res.status(200).json({ ok: true, stockCode, dateFrom, dateTo: dateTo || '누적(최신까지)', rows });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.response?.data || err.message });
      }
    });
  }
);

// ------------------------------------------------------------
// 진단용 함수 - HTS(eFriend Plus) [0110]에서 서버저장한 "내 조건" 목록 확인
//   ([국내주식] 시세분석 > 종목조건검색 목록조회, 국내주식-038, HHKST03900300)
// 사용 예: /getConditionList?user_id=본인HTS아이디
// ------------------------------------------------------------
exports.getConditionList = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const appKey = KIS_APP_KEY.value();
        const appSecret = KIS_APP_SECRET.value();
        const token = await getAccessToken(appKey, appSecret);
        const userId = req.query.user_id;
        if (!userId) {
          res.status(400).json({ ok: false, error: 'user_id 쿼리 파라미터가 필요해요 (본인 HTS 아이디)' });
          return;
        }

        const result = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/psearch-title`, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'HHKST03900300',
            custtype: 'P',
          },
          params: { user_id: userId },
        });

        res.status(200).json({ ok: true, conditions: result.data.output2 || [] });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.response?.data || err.message });
      }
    });
  }
);

// ------------------------------------------------------------
// 진단용 함수 - 저장된 조건 하나를 실제로 실행해서 종목 리스트 확인
//   ([국내주식] 시세분석 > 종목조건검색조회, 국내주식-039, HHKST03900400)
// 사용 예: /getConditionResult?user_id=본인HTS아이디&seq=0
// ------------------------------------------------------------
exports.getConditionResult = onRequest(
  { secrets: [KIS_APP_KEY, KIS_APP_SECRET] },
  async (req, res) => {
    cors(req, res, async () => {
      try {
        const appKey = KIS_APP_KEY.value();
        const appSecret = KIS_APP_SECRET.value();
        const token = await getAccessToken(appKey, appSecret);
        const userId = req.query.user_id;
        const seq = req.query.seq;
        if (!userId || seq === undefined) {
          res.status(400).json({ ok: false, error: 'user_id, seq 쿼리 파라미터가 둘 다 필요해요' });
          return;
        }

        const result = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/psearch-result`, {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: 'HHKST03900400',
            custtype: 'P',
          },
          params: { user_id: userId, seq },
        });

        const rows = (result.data.output2 || []).map((r) => ({
          code: r.code,
          name: r.name,
          price: r.price,
          changePct: r.chgrate,
          volume: r.acml_vol,
          tradeAmt: r.trade_amt,
          marketCap: r.stotprice,
        }));

        res.status(200).json({ ok: true, count: rows.length, rows });
      } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: err.response?.data || err.message });
      }
    });
  }
);

/**
 * ============================================================
 *  getHomePage — 홈페이지(/) 를 정적 파일 대신 이 함수가 직접 응답하도록 교체
 *  목적: 크롤러/애드센스가 JS 실행 전에도 실제 데이터가 담긴 HTML을 볼 수 있게 함
 *
 *  동작 방식:
 *    1) Firestore의 antData/latest 캐시를 읽는다 (KIS를 직접 호출하지 않음 — 기존 getAntData와 동일한 전략)
 *    2) 캐시 데이터로 "요약 스냅샷 HTML"을 만든다 (지수, 수급, 공매도 TOP5, 신용잔고 TOP5)
 *    3) 기존 index.html 템플릿 파일을 읽어서, <body> 바로 아래에 그 스냅샷을 끼워 넣는다
 *    4) 완성된 HTML을 응답으로 돌려준다
 *
 *  주의: 기존 클라이언트 JS(fetch(ANT_API_URL) 등)는 전혀 손대지 않았음.
 *        페이지가 열린 뒤에는 지금처럼 그대로 30초마다 자동 갱신됨.
 *        이 스냅샷은 "최초 HTML 응답에 보이는 초기 콘텐츠"만 담당함.
 *
 *  배포 전 필수: 이 파일(index.js)이 있는 폴더 안에 index.html 사본을 같이 넣어둘 것
 *  (아래 loadIndexTemplate()이 __dirname 기준으로 index.html을 읽음)
 * ============================================================
 */

// ------------------------------------------------------------
// 숫자 포맷 헬퍼
// ------------------------------------------------------------
function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR');
}
function fmtSigned(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toLocaleString('ko-KR');
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const v = Number(n);
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}
// 공매도/신용잔고 API는 억원 단위가 아닌 필드가 섞여 있어 주석에 맞춰 변환
function wonToEok(won) { // 원 -> 억원
  if (won === null || won === undefined || isNaN(won)) return null;
  return Math.round(Number(won) / 100000000);
}
function manwonToEok(manwon) { // 만원 -> 억원
  if (manwon === null || manwon === undefined || isNaN(manwon)) return null;
  return Math.round((Number(manwon) * 10000) / 100000000);
}

// ------------------------------------------------------------
// 캐시 데이터 -> 요약 스냅샷 HTML
// ------------------------------------------------------------
function buildSnapshotHtml(data) {
  if (!data) {
    return '<section id="ssr-snapshot" style="max-width:1000px;margin:16px auto;padding:0 20px;font-family:sans-serif;color:#8A8F98;font-size:13px;">데이터를 준비 중이에요.</section>';
  }

  const kospi = data.indices?.kospi;
  const kosdaq = data.indices?.kosdaq;
  const kospiFlow = data.flowByMarket?.kospi;
  const kosdaqFlow = data.flowByMarket?.kosdaq;
  const credit = data.marketCredit;

  const shortTop5 = (data.shortSaleTop ?? []).slice(0, 5);
  const creditTop5 = (data.creditBalanceTop ?? []).slice(0, 5);

  const updatedAtStr = data.updatedAt
    ? new Date(data.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '-';

  const indexBox = (label, idx, flow) => `
    <div style="flex:1;min-width:200px;background:#F6F7F9;border:1px solid #E8EAED;border-radius:12px;padding:14px 16px;">
      <div style="font-size:12px;font-weight:700;color:#8A8F98;">${label}</div>
      <div style="font-size:19px;font-weight:800;margin:4px 0;">${idx ? fmtNum(idx.value) : '-'}</div>
      <div style="font-size:12.5px;color:${idx && Number(idx.change) < 0 ? '#3B82F6' : '#E5484D'};">
        ${idx ? `${fmtSigned(idx.change)} (${fmtPct(idx.changePct)})` : '-'}
      </div>
      ${flow ? `
      <div style="display:flex;gap:10px;margin-top:8px;font-size:11.5px;color:#8A8F98;">
        <span>개인 ${fmtSigned(flow.individual?.amount)}</span>
        <span>외국인 ${fmtSigned(flow.foreign?.amount)}</span>
        <span>기관 ${fmtSigned(flow.institution?.amount)}</span>
      </div>` : ''}
    </div>`;

  const shortRows = shortTop5.map((r, i) => `
    <tr>
      <td style="padding:6px 8px;">${i + 1}</td>
      <td style="padding:6px 8px;">${r.name ?? '-'}</td>
      <td style="padding:6px 8px;text-align:right;">${fmtPct(r.changePct)}</td>
      <td style="padding:6px 8px;text-align:right;">${wonToEok(r.shortValue) !== null ? fmtNum(wonToEok(r.shortValue)) + '억' : '-'}</td>
    </tr>`).join('');

  const creditRows = creditTop5.map((r, i) => `
    <tr>
      <td style="padding:6px 8px;">${i + 1}</td>
      <td style="padding:6px 8px;">${r.name ?? '-'}</td>
      <td style="padding:6px 8px;text-align:right;">${fmtPct(r.changePct)}</td>
      <td style="padding:6px 8px;text-align:right;">${manwonToEok(r.loanBalanceAmt) !== null ? fmtNum(manwonToEok(r.loanBalanceAmt)) + '억' : '-'}</td>
    </tr>`).join('');

  return `
  <section id="ssr-snapshot" style="max-width:1000px;margin:16px auto 0;padding:0 20px;font-family:'Pretendard',sans-serif;color:#16181C;">
    <p style="font-size:13px;color:#8A8F98;margin:0 0 10px;">
      개미데이터가 매일 코스피·코스닥 지수, 공매도·신용잔고 TOP30, 기관·외국인 수급을
      실시간으로 정리해서 보여드려요. (기준: ${updatedAtStr})
    </p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
      ${indexBox('KOSPI', kospi, kospiFlow)}
      ${indexBox('KOSDAQ', kosdaq, kosdaqFlow)}
      <div style="flex:1;min-width:200px;background:#F6F7F9;border:1px solid #E8EAED;border-radius:12px;padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;color:#8A8F98;">신용잔고 · 시장전체</div>
        <div style="font-size:19px;font-weight:800;margin:4px 0;">${credit ? fmtNum(credit.creditLoanBalance) + '억' : '-'}</div>
        <div style="font-size:11.5px;color:#8A8F98;">
          ${credit ? `${credit.date ?? ''} 기준 · 고객예탁금 ${fmtNum(credit.custDeposit)}억 · 미수금 ${fmtNum(credit.unsettledAmt)}억` : '-'}
        </div>
      </div>
    </div>

    <div style="display:flex;gap:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;">
        <div style="font-size:14px;font-weight:800;margin-bottom:6px;">공매도 금액 TOP5</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="color:#8A8F98;font-size:11.5px;"><th style="text-align:left;padding:4px 8px;">#</th><th style="text-align:left;padding:4px 8px;">종목명</th><th style="text-align:right;padding:4px 8px;">등락률</th><th style="text-align:right;padding:4px 8px;">공매도금액</th></tr></thead>
          <tbody>${shortRows || '<tr><td colspan="4" style="padding:6px 8px;color:#8A8F98;">데이터 준비 중</td></tr>'}</tbody>
        </table>
      </div>
      <div style="flex:1;min-width:280px;">
        <div style="font-size:14px;font-weight:800;margin-bottom:6px;">신용잔고금액 TOP5</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="color:#8A8F98;font-size:11.5px;"><th style="text-align:left;padding:4px 8px;">#</th><th style="text-align:left;padding:4px 8px;">종목명</th><th style="text-align:right;padding:4px 8px;">등락률</th><th style="text-align:right;padding:4px 8px;">신용잔고금액</th></tr></thead>
          <tbody>${creditRows || '<tr><td colspan="4" style="padding:6px 8px;color:#8A8F98;">데이터 준비 중</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

// ------------------------------------------------------------
// index.html 템플릿 파일 (배포 폴더에 함께 올라가야 함) — 1회만 읽어서 메모리에 캐싱
// ------------------------------------------------------------
let indexTemplateCache = null;
function loadIndexTemplate() {
  if (indexTemplateCache) return indexTemplateCache;
  const templatePath = path.join(__dirname, 'index.html'); // functions 폴더에 index.html 사본을 같이 둘 것
  indexTemplateCache = fs.readFileSync(templatePath, 'utf8');
  return indexTemplateCache;
}

// 아주 짧은 인메모리 캐시 (Firestore 읽기 횟수 절약용, 인스턴스 재사용 시에만 유효)
let homePageMemCache = { html: null, expiresAt: 0 };

exports.getHomePage = onRequest({ region: 'asia-northeast3' }, async (req, res) => {
  try {
    const now = Date.now();
    if (homePageMemCache.html && now < homePageMemCache.expiresAt) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
      res.status(200).send(homePageMemCache.html);
      return;
    }

    const snap = await db.collection('antData').doc('latest').get();
    const data = snap.exists ? snap.data() : null;

    const template = loadIndexTemplate();
    const snapshotHtml = buildSnapshotHtml(data);

    // <body> 바로 다음에 스냅샷 섹션을 삽입 (noscript 블록이 있다면 그 다음, 없다면 <body> 다음)
    const html = template.replace('<body>', `<body>\n${snapshotHtml}\n`);

    homePageMemCache = { html, expiresAt: now + 30 * 1000 }; // 30초 캐시

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=30, s-maxage=30');
    res.status(200).send(html);
  } catch (err) {
    console.error('getHomePage error:', err);
    // 실패 시에도 최소한 정적 템플릿은 그대로 보여줘서 사이트가 완전히 죽지 않게 함
    try {
      const template = loadIndexTemplate();
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(template);
    } catch (fallbackErr) {
      res.status(500).send('Internal Server Error');
    }
  }
});
