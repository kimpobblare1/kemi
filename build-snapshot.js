/**
 * ============================================================
 *  build-snapshot.js
 *  - ANT_API_URL(개미데이터 백엔드)에서 최신 데이터를 받아와
 *    index.html 안의 <!-- SSR_SNAPSHOT_START -->...<!-- SSR_SNAPSHOT_END -->
 *    구간을 "실제 숫자가 채워진 HTML"로 갈아끼운다.
 *  - GitHub Actions가 이 스크립트를 몇 분마다 실행 → 바뀐 index.html을
 *    자동 커밋·푸시 → GitHub Pages가 그 커밋을 그대로 다시 배포.
 *  - 결과: 크롤러가 "불러오는 중..." 대신, 최근 몇 분 이내의 실제 데이터가
 *    이미 박혀있는 정적 HTML을 보게 됨.
 *
 *  실행: node build-snapshot.js
 *  (Node 18+ 권장 — 전역 fetch 사용. 더 낮은 버전이면 node-fetch 설치 필요)
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

const ANT_API_URL = 'https://kemidata-813625362143.asia-northeast3.run.app';
const INDEX_PATH = path.join(__dirname, 'index.html'); // 저장소 루트에 index.html이 있다고 가정 (경로 다르면 수정)

const START_MARK = '<!-- SSR_SNAPSHOT_START -->';
const END_MARK = '<!-- SSR_SNAPSHOT_END -->';

// ---------- 숫자 포맷 헬퍼 ----------
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
function wonToEok(won) {
  if (won === null || won === undefined || isNaN(won)) return null;
  return Math.round(Number(won) / 100000000);
}
function manwonToEok(manwon) {
  if (manwon === null || manwon === undefined || isNaN(manwon)) return null;
  return Math.round((Number(manwon) * 10000) / 100000000);
}
// 기관·외국인·개인 순매수금액은 "백만원" 단위로 내려옴 -> 억원으로 변환(÷100) 후 부호 포함 표시
function fmtSignedEokFromMillion(millionWon) {
  if (millionWon === null || millionWon === undefined || isNaN(millionWon)) return '-';
  const eokVal = Number(millionWon) / 100;
  const rounded = Math.round(eokVal);
  return (rounded > 0 ? '+' : '') + rounded.toLocaleString('ko-KR') + '억';
}
// 억원 -> 조원 (예: 284180억 -> "28.4조원") — 신용잔고·고객예탁금처럼 큰 숫자 표시용
function fmtEokToJo(eokVal) {
  if (eokVal === null || eokVal === undefined || isNaN(eokVal)) return '-';
  return (Number(eokVal) / 10000).toFixed(1) + '조원';
}
// "YYYYMMDD" -> "MM/DD"
function fmtYmdShort(yyyymmdd) {
  const s = String(yyyymmdd || '');
  if (s.length !== 8) return s;
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

// ---------- 데이터 -> 스냅샷 HTML ----------
function buildSnapshotHtml(data) {
  if (!data) {
    return `${START_MARK}<section id="ssr-snapshot" style="max-width:1000px;margin:16px auto;padding:0 20px;font-family:sans-serif;color:#8A8F98;font-size:13px;">데이터를 준비 중이에요.</section>${END_MARK}`;
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
        <span>개인 ${fmtSignedEokFromMillion(flow.individual?.amount)}</span>
        <span>외국인 ${fmtSignedEokFromMillion(flow.foreign?.amount)}</span>
        <span>기관 ${fmtSignedEokFromMillion(flow.institution?.amount)}</span>
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

  return `${START_MARK}
  <section id="ssr-snapshot" style="max-width:1000px;margin:16px auto 0;padding:0 20px;font-family:'Pretendard',sans-serif;color:#16181C;">
    <p style="font-size:13px;color:#8A8F98;margin:0 0 10px;">
      개미데이터가 매일 코스피·코스닥 지수, 공매도·신용잔고 TOP30, 기관·외국인 수급을
      정리해서 보여드려요. (기준: ${updatedAtStr})
    </p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;">
      ${indexBox('KOSPI', kospi, kospiFlow)}
      ${indexBox('KOSDAQ', kosdaq, kosdaqFlow)}
      <div style="flex:1;min-width:200px;background:#F6F7F9;border:1px solid #E8EAED;border-radius:12px;padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;color:#8A8F98;">신용잔고 · 시장전체</div>
        <div style="font-size:19px;font-weight:800;margin:4px 0;">${credit ? fmtEokToJo(credit.creditLoanBalance) : '-'}</div>
        <div style="font-size:11.5px;color:#8A8F98;">
          ${credit ? `${fmtYmdShort(credit.date)} 기준 · 고객예탁금 ${fmtEokToJo(credit.custDeposit)} · 미수금 ${fmtNum(credit.unsettledAmt)}억` : '-'}
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
  </section>
${END_MARK}`;
}

async function main() {
  let data = null;
  try {
    const res = await fetch(ANT_API_URL);
    const json = await res.json();
    if (json.ok) data = json.data;
    else console.error('API 응답 실패:', json.error);
  } catch (err) {
    console.error('API 호출 실패:', err.message);
    // 실패해도 기존 index.html은 건드리지 않고 그냥 종료 (마지막으로 성공했던 스냅샷을 그대로 유지)
    process.exit(0);
  }

  let html = fs.readFileSync(INDEX_PATH, 'utf8');
  const snapshot = buildSnapshotHtml(data);

  if (html.includes(START_MARK) && html.includes(END_MARK)) {
    // 이미 마커가 있으면 그 사이만 교체
    const before = html.slice(0, html.indexOf(START_MARK));
    const after = html.slice(html.indexOf(END_MARK) + END_MARK.length);
    html = before + snapshot + after;
  } else {
    // 마커가 아직 없으면 <body> 바로 다음에 최초 삽입
    html = html.replace('<body>', `<body>\n${snapshot}\n`);
  }

  fs.writeFileSync(INDEX_PATH, html, 'utf8');
  console.log('index.html 스냅샷 갱신 완료:', new Date().toISOString());
}

main();
