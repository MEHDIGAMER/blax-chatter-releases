// BLAX Agency — Shared Telegram + Firebase logic
// Uses Firebase REST API (no SDK — works with open rules)
'use strict';
const https = require('https');

const DB = 'https://blaxcrm-default-rtdb.asia-southeast1.firebasedatabase.app';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Firebase REST ──
function fbGet(path) {
  return new Promise((resolve) => {
    https.get(`${DB}${path}.json`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); }});
    }).on('error', () => resolve(null));
  });
}

// ── Telegram send ──
function sendMsg(chatId, text, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

// ── Helpers ──
function fmt$(n) { return '$' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0}); }
function fmtPct(n) { return Math.round(n||0) + '%'; }

// ── Build hourly report ──
async function buildReport() {
  const now = Date.now();
  const [salesRaw, shiftsRaw, monRaw, lbRaw] = await Promise.all([
    fbGet('/blax-agency/sales'),
    fbGet('/blax-agency/shifts'),
    fbGet('/blax-agency/monitoring'),
    fbGet(`/blax-agency/leaderboard/daily/${new Date().toISOString().split('T')[0]}`)
  ]);

  const sales   = Object.values(salesRaw  || {});
  const shifts  = Object.values(shiftsRaw || {});
  const mon     = monRaw || {};
  const lb      = Object.values(lbRaw || {}).sort((a,b) => (b.totalSales||0)-(a.totalSales||0));

  // Revenue windows
  const s1h  = sales.filter(s => now-(s.ts||0) < 3600000);
  const s3h  = sales.filter(s => now-(s.ts||0) < 10800000);
  const s24h = sales.filter(s => now-(s.ts||0) < 86400000);
  const rev1h  = s1h.reduce((t,s)=>t+(s.amount||0), 0);
  const rev3h  = s3h.reduce((t,s)=>t+(s.amount||0), 0);
  const rev24h = s24h.reduce((t,s)=>t+(s.amount||0), 0);
  const hourlyRate = s3h.length ? rev3h/3 : rev1h;

  // Active shifts
  const active = shifts.filter(s => s.active);
  const online = Object.values(mon).filter(m => m.online).length;

  // Per-chatter lines
  const chatterLines = active.map(s => {
    const m = mon[s.chatterId] || {};
    const isIdle = m.online && m.idleSince && (now-m.idleSince)>60000;
    const idleMins = isIdle ? Math.floor((now-m.idleSince)/60000) : 0;
    const shiftMins = s.startTime ? Math.floor((now-s.startTime)/60000) : 0;
    const icon = !m.online ? '⚫️' : isIdle ? '🟡' : '🟢';
    const idleStr = isIdle ? ` ⏸ idle ${idleMins}m` : '';
    return `${icon} <b>${s.chatterName||'?'}</b> [${s.model||'--'}] — ${fmt$(s.totalSales||0)} · ${(s.sales||[]).length} PPVs · ${shiftMins}m${idleStr}`;
  });

  // Model breakdown 24h
  const modelRev = {};
  s24h.forEach(s => { modelRev[s.model] = (modelRev[s.model]||0)+(s.amount||0); });

  // Whale detection: 3+ PPVs same fan today
  const fanMap = {};
  s24h.forEach(s => {
    const k = `${s.chatterId}:${s.fanUsername}`;
    if (!fanMap[k]) fanMap[k] = { fan:s.fanUsername, chatter:s.chatterName, model:s.model, count:0, total:0 };
    fanMap[k].count++;
    fanMap[k].total += s.amount||0;
  });
  const whales = Object.values(fanMap).filter(f=>f.count>=3).sort((a,b)=>b.total-a.total);

  // Alerts
  const alerts = [];
  Object.entries(mon).forEach(([cid, m]) => {
    if (m.doubleShiftAlert) alerts.push(`🚨 Double shift — ${m.name||cid}`);
    if (m.online && m.idleSince && (now-m.idleSince)>900000)
      alerts.push(`🟡 Idle ${Math.floor((now-m.idleSince)/60000)}m — ${m.name||cid}`);
    if (m.newDeviceAlert && m.newDeviceTs && (now-m.newDeviceTs)<259200000)
      alerts.push(`📱 New device login — ${m.name||cid}`);
  });
  active.forEach(s => {
    const mins = Math.floor((now-s.startTime)/60000);
    const lastSale = sales.filter(x=>x.chatterId===s.chatterId).reduce((max,x)=>Math.max(max,x.ts||0),0);
    if (mins>=60 && (!lastSale||(now-lastSale)>3600000))
      alerts.push(`⚠️ No sale 60m+ — ${s.chatterName}`);
    if (mins>=120 && (s.totalSales||0)<150)
      alerts.push(`📉 Below pace — ${s.chatterName} (${fmt$(s.totalSales||0)} in ${mins}m)`);
  });

  const time = new Date().toLocaleString('en-US', {
    timeZone:'Asia/Bangkok', weekday:'short', month:'short',
    day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true
  });

  let msg = `🏢 <b>BLAX Agency — Hourly Report</b>\n`;
  msg += `⏰ ${time} (BKK)\n`;
  msg += `━━━━━━━━━━━━━━━━━\n\n`;

  msg += `💰 <b>Revenue</b>\n`;
  msg += `• Last 1h:  <b>${fmt$(rev1h)}</b>\n`;
  msg += `• Last 24h: <b>${fmt$(rev24h)}</b>\n`;
  msg += `• Pace:     <b>${fmt$(hourlyRate)}/hr</b> (~${fmt$(hourlyRate*24)}/day est.)\n\n`;

  msg += `👥 <b>Active Chatters</b> — ${online} online\n`;
  if (chatterLines.length) {
    msg += chatterLines.join('\n') + '\n';
  } else {
    msg += `No active shifts.\n`;
  }

  if (Object.keys(modelRev).length) {
    msg += `\n📊 <b>Model Revenue (24h)</b>\n`;
    Object.entries(modelRev).sort((a,b)=>b[1]-a[1]).forEach(([m,r]) => {
      msg += `• ${m}: <b>${fmt$(r)}</b>\n`;
    });
  }

  if (lb.length) {
    msg += `\n🏆 <b>Today's Top Earners</b>\n`;
    const medals = ['🥇','🥈','🥉'];
    lb.slice(0,3).forEach((e,i) => {
      msg += `${medals[i]||`#${i+1}`} ${e.name} [${e.model}] — <b>${fmt$(e.totalSales||0)}</b> (${e.saleCount||0} sales)\n`;
    });
  }

  if (whales.length) {
    msg += `\n🐋 <b>Whale Alerts (3+ PPVs)</b>\n`;
    whales.forEach(w => {
      msg += `• <b>${w.fan}</b> → ${w.chatter} [${w.model}]: ${w.count} PPVs · ${fmt$(w.total)}\n`;
    });
  }

  if (alerts.length) {
    msg += `\n🚨 <b>Alerts</b>\n`;
    alerts.forEach(a => msg += `${a}\n`);
  } else {
    msg += `\n✅ No active alerts.\n`;
  }

  return msg;
}

// ── Handle bot commands ──
async function handleCommand(command, chatId) {
  if (String(chatId) !== String(CHAT_ID)) return; // security: only owner
  const now = Date.now();

  if (command === '/report' || command === '/r') {
    const report = await buildReport();
    return sendMsg(chatId, report);
  }

  if (command === '/now' || command === '/sales') {
    const sales = Object.values(await fbGet('/blax-agency/sales') || {});
    const rev1h  = sales.filter(s=>now-(s.ts||0)<3600000).reduce((t,s)=>t+(s.amount||0),0);
    const rev24h = sales.filter(s=>now-(s.ts||0)<86400000).reduce((t,s)=>t+(s.amount||0),0);
    const rev7d  = sales.filter(s=>now-(s.ts||0)<604800000).reduce((t,s)=>t+(s.amount||0),0);
    const count24 = sales.filter(s=>now-(s.ts||0)<86400000).length;
    return sendMsg(chatId,
      `⚡️ <b>Quick Snapshot</b>\n\n` +
      `💵 Last 1h:  <b>${fmt$(rev1h)}</b>\n` +
      `💵 Last 24h: <b>${fmt$(rev24h)}</b> (${count24} transactions)\n` +
      `💵 Last 7d:  <b>${fmt$(rev7d)}</b>\n` +
      `📈 Rate: <b>${fmt$(rev1h)}/hr</b>`
    );
  }

  if (command === '/chatters') {
    const [shiftsRaw, monRaw] = await Promise.all([fbGet('/blax-agency/shifts'), fbGet('/blax-agency/monitoring')]);
    const active = Object.values(shiftsRaw||{}).filter(s=>s.active);
    const mon = monRaw||{};
    if (!active.length) return sendMsg(chatId, '👥 No active shifts right now.');
    let msg = `👥 <b>Active Chatters (${active.length})</b>\n\n`;
    active.forEach(s => {
      const m = mon[s.chatterId]||{};
      const isIdle = m.online && m.idleSince && (now-m.idleSince)>60000;
      const icon = !m.online?'⚫️':isIdle?'🟡':'🟢';
      const dur = s.startTime?Math.floor((now-s.startTime)/60000):0;
      const idleStr = isIdle?`\n   ⏸ Idle ${Math.floor((now-m.idleSince)/60000)}m`:'';
      const res = mon[s.chatterId]?.screenResolution ? `\n   🖥 ${mon[s.chatterId].screenResolution}`:'';
      msg += `${icon} <b>${s.chatterName}</b> [${s.model}]\n   ${fmt$(s.totalSales||0)} · ${(s.sales||[]).length} PPVs · ${dur}m${idleStr}${res}\n\n`;
    });
    return sendMsg(chatId, msg);
  }

  if (command === '/whales') {
    const sales = Object.values(await fbGet('/blax-agency/sales')||{});
    const today = sales.filter(s=>now-(s.ts||0)<86400000);
    const fanMap = {};
    today.forEach(s=>{
      const k=`${s.chatterId}:${s.fanUsername}`;
      if(!fanMap[k]) fanMap[k]={fan:s.fanUsername,chatter:s.chatterName,model:s.model,count:0,total:0};
      fanMap[k].count++;fanMap[k].total+=s.amount||0;
    });
    const whales = Object.values(fanMap).filter(f=>f.count>=3).sort((a,b)=>b.total-a.total);
    if (!whales.length) return sendMsg(chatId,'🐋 No whale alerts today (3+ PPVs same fan).');
    let msg=`🐋 <b>Whale Alerts Today</b>\n\n`;
    whales.forEach(w=>{msg+=`👤 <b>${w.fan}</b>\n   → ${w.chatter} [${w.model}]\n   ${w.count} PPVs · <b>${fmt$(w.total)}</b>\n\n`;});
    return sendMsg(chatId,msg);
  }

  if (command === '/top') {
    const lb = await fbGet(`/blax-agency/leaderboard/daily/${new Date().toISOString().split('T')[0]}`);
    const entries = Object.values(lb||{}).sort((a,b)=>(b.totalSales||0)-(a.totalSales||0));
    if (!entries.length) return sendMsg(chatId,'🏆 No sales on leaderboard yet today.');
    let msg=`🏆 <b>Today's Leaderboard</b>\n\n`;
    const medals=['🥇','🥈','🥉'];
    entries.slice(0,5).forEach((e,i)=>{
      msg+=`${medals[i]||`#${i+1}`} <b>${e.name}</b> [${e.model||'--'}]\n   ${fmt$(e.totalSales||0)} · ${e.saleCount||0} sales\n\n`;
    });
    return sendMsg(chatId,msg);
  }

  if (command === '/alerts') {
    const [monRaw, shiftsRaw, salesRaw] = await Promise.all([
      fbGet('/blax-agency/monitoring'), fbGet('/blax-agency/shifts'), fbGet('/blax-agency/sales')
    ]);
    const mon=monRaw||{};const active=Object.values(shiftsRaw||{}).filter(s=>s.active);
    const sales=Object.values(salesRaw||{});
    const alerts=[];
    Object.entries(mon).forEach(([cid,m])=>{
      if(m.doubleShiftAlert) alerts.push(`🚨 <b>Double shift detected</b> — ${m.name||cid}`);
      if(m.online&&m.idleSince&&(now-m.idleSince)>900000) alerts.push(`🟡 <b>Extended idle ${Math.floor((now-m.idleSince)/60000)}m</b> — ${m.name||cid}`);
      if(m.newDeviceAlert&&m.newDeviceTs&&(now-m.newDeviceTs)<259200000) alerts.push(`📱 <b>New device login</b> — ${m.name||cid}`);
    });
    active.forEach(s=>{
      const mins=Math.floor((now-s.startTime)/60000);
      const lastSale=sales.filter(x=>x.chatterId===s.chatterId).reduce((max,x)=>Math.max(max,x.ts||0),0);
      if(mins>=60&&(!lastSale||(now-lastSale)>3600000)) alerts.push(`⚠️ <b>No sale 60m+</b> — ${s.chatterName} (${mins}m on shift)`);
      if(mins>=120&&(s.totalSales||0)<150) alerts.push(`📉 <b>Below pace</b> — ${s.chatterName} (${fmt$(s.totalSales||0)} in ${mins}m)`);
    });
    if (!alerts.length) return sendMsg(chatId,'✅ All clear — no active alerts.');
    return sendMsg(chatId,`🚨 <b>Active Alerts (${alerts.length})</b>\n\n${alerts.join('\n')}`);
  }

  if (command === '/ppv') {
    // Alert: chatters who sold 3+ PPVs to same fan this shift
    const [shiftsRaw, salesRaw] = await Promise.all([fbGet('/blax-agency/shifts'), fbGet('/blax-agency/sales')]);
    const active = Object.values(shiftsRaw||{}).filter(s=>s.active);
    const sales = Object.values(salesRaw||{});
    const findings = [];
    active.forEach(s=>{
      const shiftSales = sales.filter(x=>x.chatterId===s.chatterId&&x.ts>=s.startTime);
      const fanMap={};
      shiftSales.forEach(x=>{
        fanMap[x.fanUsername]=(fanMap[x.fanUsername]||0)+1;
      });
      Object.entries(fanMap).forEach(([fan,count])=>{
        if(count>=3) findings.push(`• <b>${fan}</b> → ${s.chatterName}: ${count} PPVs this shift`);
      });
    });
    if(!findings.length) return sendMsg(chatId,'📊 No fan at 3+ PPVs this shift yet.');
    return sendMsg(chatId,`📊 <b>3+ PPVs Same Fan (Current Shifts)</b>\n\n${findings.join('\n')}`);
  }

  if (command === '/help') {
    return sendMsg(chatId,
      `🤖 <b>BLAX Agency Bot</b>\n\n` +
      `<b>Reports</b>\n` +
      `/report — Full hourly report\n` +
      `/now — Quick revenue snapshot\n\n` +
      `<b>Chatters</b>\n` +
      `/chatters — Who's online + their stats\n` +
      `/top — Today's leaderboard\n` +
      `/alerts — Active alerts\n` +
      `/ppv — 3+ PPVs same fan this shift\n` +
      `/whales — Fans with 3+ PPVs today\n\n` +
      `📊 Hourly reports sent automatically.`
    );
  }
}

module.exports = { buildReport, handleCommand, sendMsg, CHAT_ID };
