/**
 * ============================================================
 *  build-snapshot.js (v2 — 화면 중복 문제 수정)
 *
 *  [이전 버전의 문제]
 *  <body> 바로 아래에 별도 <section id="ssr-snapshot">를 새로 끼워넣는 방식이었음.
 *  → 실제 방문자에게도 "요약 스냅샷"과 "원래 대시보드"가 위아래로 중복 노출되는
 *    화면 깨짐이 발생함.
 *
 *  [이번 버전의 방식]
 *  새 섹션을 추가하지 않고, 기존 화면의 빈 자리("불러오는 중...", "-")에
 *  직접 실제 값을 채워넣음. 즉 index.html의 #kospi-value, #kospi-change,
 *  #home-short-tbody 같은 기존 id들 안의 내용을 실제 데이터로 교체함.
 *  → 방문자는 원래 화면 그대로 보고(중복 없음), 크롤러도 같은 화면에서
 *    실제 숫자를 보게 됨. 사이트에 로드된 클라이언트 JS는 그 후 평소처럼
 *    다시 최신 데이터로 자연스럽게 덮어씀(사용자 입장에서 거의 티 안 남).
 *
 *  실행: node build-snapshot.js
 *  (Node 18+ 권장 — 전역 fetch 사용)
 * ============================================================
 */
const fs = require('fs');
const path = require('path');

const ANT_API_URL = 'https://kemidata-813625362143.asia-northeast3.run.app';
const INDEX_PATH = path.join(__dirname, 'index.html'); // 경로 다르면 수정

// ---------- index.html의 클라이언트 JS 포맷 함수와 동일하게 맞춘 헬퍼 ----------
function fmtNum(n) {
  const num = Number(n);
  if (isNaN(num)) return '-';
  return num.toLocaleString('ko-KR');
}
function trendSymbol(p) {
  const num = Number(p);
  if (isNaN(num) || num === 0) return '－';
  return num > 0 ? '▲' : '▼';
}
function pctClass(p) {
  const num = Number(p);
  if (isNaN(num) || num === 0) return 'chg-flat';
  return num > 0 ? 'chg-up' : 'chg-down';
}
function fmtPctAbs(p) {
  const num = Number(p);
  if (isNaN(num)) return '-';
  return Math.abs(num).toFixed(2) + '%';
}
function fmtPointAbs(p) {
  const num = Number(p);
  if (isNaN(num)) return '-';
  return Math.abs(num).toFixed(2);
}
function fmtChangeAmtAbs(n) {
  const num = Number(n);
  if (isNaN(num) || n === null) return '-';
  return Math.abs(Math.round(num)).toLocaleString('ko-KR');
}
function fmtEokToJo(eokVal) {
  const num = Number(eokVal);
  if (isNaN(num)) return '-';
  return (num / 10000).toFixed(1) + '조원';
}
function fmtEokAmt(eokVal) {
  const num = Number(eokVal);
  if (isNaN(num)) return '-';
  return Math.round(num).toLocaleString('ko-KR') + '억';
}
function fmtYmd(yyyymmdd) {
  const s = String(yyyymmdd || '');
  if (s.length !== 8) return '';
  return `${s.slice(4, 6)}/${s.slice(6, 8)}`;
}
function fmtBsopDate(yyyymmdd) {
  const ymd = fmtYmd(yyyymmdd);
  return ymd ? `${ymd} 기준` : '';
}
function eok(rawWon) {
  const num = Number(rawWon);
  if (isNaN(num)) return '-';
  const eokVal = num / 1e8;
  const rounded = Math.round(eokVal);
  if (rounded === 0 && eokVal !== 0) return eokVal.toFixed(2);
  return rounded.toLocaleString('ko-KR');
}
function eokFromManwon(manwon) {
  const num = Number(manwon);
  if (isNaN(num)) return '-';
  const eokVal = num / 10000;
  const rounded = Math.round(eokVal);
  if (rounded === 0 && eokVal !== 0) return eokVal.toFixed(2);
  return rounded.toLocaleString('ko-KR');
}
// 라이트 모드 고정 버전 (크롤러/최초 로드 시점 기준 — 클라이언트 JS가 로드되면 다크모드 여부에 맞게 다시 그려줌)
function ratioChip(ratio, max) {
  const num = Number(ratio);
  const text = isNaN(num) ? '-' : num.toFixed(2) + '%';
  const t = Math.max(0, Math.min((Number(ratio) || 0) / max, 1));
  const fgFrom = [214, 158, 46], fgTo = [176, 92, 8];
  const fg = fgFrom.map((f, i) => Math.round(f + (fgTo[i] - f) * t));
  return `<span class="ratio-chip" style="color:rgb(${fg.join(',')});background:rgba(194,118,12,0.09);border:1px solid rgba(194,118,12,${(0.24 + 0.4 * t).toFixed(2)})">${text}</span>`;
}
function flowAmountText(flow) {
  if (!flow) return { text: '-', cls: 'chg-flat' };
  const eokVal = Number(flow.amount) / 100;
  if (isNaN(eokVal)) return { text: '-', cls: 'chg-flat' };
  const cls = eokVal > 0 ? 'chg-up' : (eokVal < 0 ? 'chg-down' : 'chg-flat');
  const text = (eokVal > 0 ? '+' : '') + Math.round(eokVal).toLocaleString('ko-KR');
  return { text, cls };
}
const priceCell = (r) => `<td class="num-cell">${fmtNum(r.price)}</td>`;
const changeCell = (r) => `<td class="num-cell ${pctClass(r.changePct)}">${trendSymbol(r.changePct)} ${fmtChangeAmtAbs(r.change)}</td>`;
const pctCell = (r) => `<td class="num-cell ${pctClass(r.changePct)}">${trendSymbol(r.changePct)} ${fmtPctAbs(r.changePct)}</td>`;

// ---------- id 기준으로 기존 태그를 통째로 교체하는 헬퍼 ----------
// (같은 태그가 안에 중첩되지 않는 요소에서만 안전 — index-value/change, flow-value, tbody 등은 해당 없음)
function replaceById(html, id, tagName, newOuterHtml) {
  const re = new RegExp(`<${tagName}\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</${tagName}>`);
  if (!re.test(html)) {
    console.warn(`[build-snapshot] id="${id}" 를 index.html에서 찾지 못해 건너뜀`);
    return html;
  }
  return html.replace(re, newOuterHtml);
}

// ---------- 홈 화면 TOP10 표 row 렌더러 (index.html의 renderRows와 동일 마크업) ----------
function renderShortRows(rows) {
  return rows.map((r) => `
    <tr>
      <td class="name-cell">${r.name}</td>
      ${priceCell(r)}
      ${changeCell(r)}
      ${pctCell(r)}
      <td class="num-cell">${ratioChip(r.shortVolumeRatio, 20)}</td>
      <td class="num-cell amount-cell">${eok(r.shortValue)}</td>
    </tr>`).join('');
}
function renderCreditRows(rows) {
  return rows.map((r) => `
    <tr>
      <td class="name-cell">${r.name}</td>
      ${priceCell(r)}
      ${changeCell(r)}
      ${pctCell(r)}
      <td class="num-cell">${ratioChip(r.loanBalanceRate, 10)}</td>
      <td class="num-cell">${ratioChip(r.marketCapBasedRate, 10)}</td>
      <td class="num-cell amount-cell">${eokFromManwon(r.loanBalanceAmt)}</td>
    </tr>`).join('');
}

// ---------- 메인: index.html 안의 "빈 자리"들을 실제 값으로 채움 ----------
function fillIndexHtml(html, data) {
  if (!data) return html; // 데이터 없으면 원본 그대로 (기존 "불러오는 중..." 유지)

  // KOSPI / KOSDAQ 지수 카드
  ['kospi', 'kosdaq'].forEach((mkt) => {
    const idx = data.indices?.[mkt];
    if (idx) {
      html = replaceById(html, `${mkt}-value`, 'div', `<div class="index-value" id="${mkt}-value">${fmtNum(idx.value)}</div>`);
      const cls = 'index-change ' + pctClass(idx.changePct);
      const inner = `<span class="trend-mark">${trendSymbol(idx.changePct)}</span><span>${fmtPointAbs(idx.change)}</span><span>${fmtPctAbs(idx.changePct)}</span>`;
      html = replaceById(html, `${mkt}-change`, 'div', `<div class="${cls}" id="${mkt}-change">${inner}</div>`);
    }
    const flow = data.flowByMarket?.[mkt];
    ['individual', 'foreign', 'institution'].forEach((who) => {
      const { text, cls } = flowAmountText(flow?.[who]);
      html = replaceById(html, `${mkt}-${who}`, 'div', `<div class="flow-value ${cls}" id="${mkt}-${who}">${text}</div>`);
    });
  });

  // 신용잔고 · 시장전체 카드
  if (data.marketCredit) {
    const mc = data.marketCredit;
    html = replaceById(html, 'market-credit-value', 'div', `<div class="index-value" id="market-credit-value">${fmtEokToJo(mc.creditLoanBalance)}</div>`);
    html = replaceById(html, 'market-credit-asof', 'div', `<div class="credit-asof" id="market-credit-asof">⏰ ${fmtBsopDate(mc.date)} · 실시간 아님 (하루 1회 갱신)</div>`);
    let changeInner, changeCls;
    if (mc.change === null || mc.change === undefined) {
      changeInner = '전일 대비 데이터 없음';
      changeCls = 'index-change chg-flat';
    } else {
      changeInner = `<span class="trend-mark">${trendSymbol(mc.change)}</span><span>${fmtEokAmt(Math.abs(mc.change))}</span><span>${fmtPctAbs(mc.changePct)}</span>`;
      changeCls = 'index-change ' + pctClass(mc.change);
    }
    html = replaceById(html, 'market-credit-change', 'div', `<div class="${changeCls}" id="market-credit-change" style="margin-bottom:10px;">${changeInner}</div>`);
    html = replaceById(html, 'market-credit-deposit', 'div', `<div class="credit-sub-value" id="market-credit-deposit">${fmtEokToJo(mc.custDeposit)}</div>`);
    html = replaceById(html, 'market-credit-unsettled', 'div', `<div class="credit-sub-value" id="market-credit-unsettled">${fmtEokAmt(mc.unsettledAmt)}</div>`);
  }

  // 홈 화면 TOP10 표 4개 (비중순/비율순 + 금액순 재정렬)
  const shortTop10 = (data.shortSaleTop || []).slice(0, 10);
  const shortByValue10 = [...(data.shortSaleTop || [])].sort((a, b) => Number(b.shortValue) - Number(a.shortValue)).slice(0, 10);
  const creditTop10 = (data.creditBalanceTop || []).slice(0, 10);
  const creditByValue10 = [...(data.creditBalanceTop || [])].sort((a, b) => Number(b.loanBalanceAmt) - Number(a.loanBalanceAmt)).slice(0, 10);

  html = replaceById(html, 'home-short-tbody', 'tbody', `<tbody id="home-short-tbody">${renderShortRows(shortTop10)}</tbody>`);
  html = replaceById(html, 'home-short-value-tbody', 'tbody', `<tbody id="home-short-value-tbody">${renderShortRows(shortByValue10)}</tbody>`);
  html = replaceById(html, 'home-credit-tbody', 'tbody', `<tbody id="home-credit-tbody">${renderCreditRows(creditTop10)}</tbody>`);
  html = replaceById(html, 'home-credit-value-tbody', 'tbody', `<tbody id="home-credit-value-tbody">${renderCreditRows(creditByValue10)}</tbody>`);

  // 상단 상태바 — "불러오는 중..." 대신 캐시 기준시각 표시 (클라이언트 JS가 로드되면 곧바로 LIVE로 갱신됨)
  if (data.updatedAt) {
    const updated = new Date(data.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    html = replaceById(html, 'status-bar', 'div', `<div class="status-bar" id="status-bar">🔄 캐시 데이터 · 기준시각 ${updated}</div>`);
  }

  return html;
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
    process.exit(0); // 실패 시 기존 index.html 그대로 유지, 에러로 워크플로 죽이지 않음
  }
  if (!data) { console.log('데이터 없음 — index.html 변경 없이 종료'); return; }

  const original = fs.readFileSync(INDEX_PATH, 'utf8');
  const updated = fillIndexHtml(original, data);
  fs.writeFileSync(INDEX_PATH, updated, 'utf8');
  console.log('index.html 갱신 완료:', new Date().toISOString());
}

main();
