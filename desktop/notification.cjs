const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

exports.NOTIFICATION_GAP = 2000;
exports.NOTIFICATION_SOUND_GAP = 60000;
exports.notificationBounds = area => {
  const margin = Math.min(20, Math.floor(Math.min(area.width, area.height) / 20));
  const width = Math.min(480, area.width - margin * 2);
  const height = Math.min(320, area.height - margin * 2);
  return { width, height, x: area.x + area.width - width - margin, y: area.y + area.height - height - margin };
};
exports.notificationDuration = candidate => candidate.previewDuration > 0
  ? Math.min(30000, candidate.previewDuration)
  : Math.min(30000, Math.max(12000, Number(candidate.displayDuration) || 0, 6000 + String(candidate.body || '').length * 70));

exports.notificationHtml = (candidate, image, duration, pending = 0) => {
  const key = String(candidate.key || '');
  const review = key.startsWith('evening-review:');
  const category = candidate.snoozedAt ? '다시 알림' : /^(deadline-|game:)/.test(key) ? '마감 확인'
    : review ? '하루 결산' : /^(class:|event:|briefing:)/.test(key) ? '일정 안내' : /^(routine:|health-check:|activity-break:)/.test(key) ? '생활 알림' : '아사';
  const original = candidate.snoozedAt ? new Date(candidate.snoozedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '에 받은 알림' : '마우스를 올리면 계속 표시';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>아사 알림</title><style>
  *{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:'Segoe UI','Malgun Gothic',sans-serif;background:#1d2527;color:#f1f4ee;overflow:hidden;color-scheme:dark}
  .card{height:100%;display:flex;flex-direction:column;padding:22px 24px 18px;border:1px solid #46514d;border-radius:18px;position:relative;overflow:hidden;background:linear-gradient(120deg,#29322f 0,#20282b 58%,#1d2527 100%)}
  header{display:flex;align-items:center;gap:13px;padding-right:38px;margin-bottom:15px}img{width:52px;height:52px;border-radius:15px;object-fit:cover;object-position:center 25%;border:1px solid #dbe8d52b}
  .identity{display:grid;gap:5px}.identity strong{font-size:16px;letter-spacing:-.3px}.category{font-size:11px;font-weight:600;letter-spacing:.4px;color:#c5d6af}h1{font-size:20px;letter-spacing:-.6px;line-height:1.4;margin:0 0 9px;overflow-wrap:anywhere;flex-shrink:0}
  .body{font-size:16px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;min-height:0;flex:1;padding-right:4px;color:#d2dcd4;scrollbar-width:thin;scrollbar-color:#69756b transparent}
  .meta{font-size:11px;color:#aab8ac;margin:12px 0 14px;display:flex;justify-content:space-between;gap:8px}.actions{display:flex;gap:8px;flex-shrink:0}
  button{font:inherit;font-size:13px;font-weight:600;border:1px solid #58665b;border-radius:10px;min-height:38px;padding:8px 15px;background:#ffffff05;color:#dce5d7;cursor:pointer;transition:background .15s}button:hover{background:#ffffff10}button:focus-visible{outline:2px solid #d1e2b5;outline-offset:3px}button:disabled{opacity:.55;cursor:wait}.primary{background:#c8d9b1;color:#263523;border-color:#c8d9b1}.primary:hover{background:#dae9c8}
  .close{position:absolute;right:16px;top:18px;border:0;font-size:23px;line-height:1;padding:0;width:36px;min-height:36px;color:#b6c2ba;background:transparent}.actions button:last-child{margin-left:auto;border-color:transparent;color:#b6c2ba}.timer{position:absolute;bottom:0;left:0;right:0;height:3px;background:#ffffff09}.timer span{display:block;height:100%;background:#a8bc91;transform-origin:left;animation:remaining ${duration}ms linear forwards;animation-play-state:paused}.running .timer span{animation-play-state:running}.paused .timer span{animation-play-state:paused}
  #error{color:#ffb5a9;font-size:12px;margin:0 0 8px}#error:empty{display:none}@keyframes remaining{to{transform:scaleX(0)}}
  @media(max-width:360px){.card{padding:14px}.actions{gap:5px}button{padding:7px 10px}.body{font-size:15px}h1{font-size:17px}.meta{font-size:10px}}
  @media(prefers-reduced-motion:reduce){.timer span{animation:none}}@media(forced-colors:active){.card,button{border:1px solid CanvasText}.primary{background:ButtonFace;color:ButtonText}.timer{display:none}}
  </style></head><body><section class="card" aria-label="아사 알림"><header><img src="${escape(image)}" alt=""><div class="identity"><strong>아사</strong><span class="category">${category}</span></div></header>
  <h1>${escape(String(candidate.title || '알림').replace(/^아사\s*·\s*/, ''))}</h1><div class="body" tabindex="0">${escape(candidate.body)}</div>
  <div class="meta"><span id="hint">${escape(original)}</span><span id="pending">${pending ? `다음 알림 ${pending}개` : ''}</span></div><p id="error" role="alert"></p>
  <div class="actions"><button type="button" class="primary" data-action="open">${review ? '결산 보기' : '열기'}</button>${review ? '' : '<button type="button" data-action="snooze">15분 뒤 다시</button>'}<button type="button" data-action="dismiss">닫기</button></div>
  <button type="button" class="close" data-action="dismiss" aria-label="알림 닫기">×</button><div class="timer" aria-hidden="true"><span></span></div></section></body></html>`;
};
