#!/usr/bin/env node
// GitHub Actions entrypoint — sends hourly report
'use strict';
const { buildReport, sendMsg, CHAT_ID } = require('./lib');

(async () => {
  try {
    const report = await buildReport();
    await sendMsg(CHAT_ID, report);
    console.log('✅ Hourly report sent to Telegram');
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
  process.exit(0);
})();
