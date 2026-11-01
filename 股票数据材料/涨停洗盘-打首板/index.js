const { isPotentialBullWashout } = require('./washout');

// 假设已读取 json 数据
// 楚天龙：2026-08-21 高开秒板启动日，应返回 true
const ctl = require('./楚天龙.json');
console.log('楚天龙', isPotentialBullWashout(ctl, 20260821));

// 金健米业：2026-08-17 高开秒板启动日，应返回 true
const jjmy = require('./金健米业.json');
console.log('金健米业', isPotentialBullWashout(jjmy, 20260817));

// 大业股份：2026-10-16 首板启动日，应返回 true
const dy = require('./大业股份.json');
console.log('大业股份', isPotentialBullWashout(dy, 20261016));

// 九阳股份：2026-09-28 高开秒板启动日，应返回 true
const jy = require('./九阳股份.json');
console.log('九阳股份', isPotentialBullWashout(jy, 20260928));

const lb = require('./龙版传媒.json');
console.log('龙版传媒', isPotentialBullWashout(lb, 20260831));

const ld = require('./联德股份.json');
console.log('联德股份', isPotentialBullWashout(ld, 20260706));

const zm = require('./祖名股份.json');
console.log('祖名股份', isPotentialBullWashout(zm, 20260706));

console.log('凤凰航运', isPotentialBullWashout(require('./凤凰航运.json'), 20260702));

console.log('华旺科技', isPotentialBullWashout(require('./华旺科技.json'), 20260706));

console.log('庄园牧场', isPotentialBullWashout(require('./庄园牧场.json'), 20260708));

console.log('亚太药业', isPotentialBullWashout(require('./亚太药业.json'), 20260710));

console.log('德才股份', isPotentialBullWashout(require('./德才股份.json'), 20261028));