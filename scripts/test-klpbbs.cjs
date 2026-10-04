const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const code = source.slice(source.indexOf('function klpbbsSignAction('), source.indexOf('async function inspectKlpbbs('));
const fixtures = require('./klpbbs-reference-fixtures.json');
let clicks = 0;
const el = (className = '', textContent = '') => ({
  classList: { contains: name => className.split(/\s+/).includes(name) },
  textContent, click: () => clicks++
});
let card, legacy, button, logout = true, login = false;
const document = {
  getElementById: id => id === 'klp-signcard' ? card : id === 'JD_sign' ? legacy : null,
  querySelector: selector => selector.includes('action=logout') ? (logout ? {} : null) : (login ? {} : null)
};
const context = vm.createContext({ document });
vm.runInContext(code, context);
const inspect = () => vm.runInContext('klpbbsSignAction()', context);
const click = () => vm.runInContext('klpbbsSignAction(true)', context);
for (const fixture of Object.values(fixtures)) {
  logout = fixture.logout;
  legacy = el(fixture.JD_sign.className);
  card = fixture['klp-signcard'] ? el(fixture['klp-signcard'].className) : null;
  assert.equal(inspect().status, 'already');
  assert.equal(click().ok, false);
}
assert.equal(clicks, 0);
card = null;
legacy = el('', '今日签到');
assert.equal(inspect().status, 'need');
assert.equal(click().ok, true);
assert.equal(clicks, 1);
legacy = el('', '已簽到');
assert.equal(inspect().status, 'already');
card = el('klp-signcard');
card.querySelector = selector => selector === '[data-klp-sign]' ? button : null;
button = el('', '今日签到');
assert.equal(inspect().status, 'pending', 'Wait for the theme to install its click handler');
button._klp = 1;
assert.equal(inspect().status, 'need');
click();
assert.equal(clicks, 2);
button = Object.assign(el('dis', '签到中…'), { _klp: 1 });
assert.equal(inspect().status, 'pending');
assert.equal(click().ok, false);
card = el('done', '今日已签到 · 看排名');
legacy = el('', '签到');
assert.equal(inspect().status, 'already');
assert.equal(click().ok, false);
card = el('', '今日已簽到 · 看排名');
assert.equal(inspect().status, 'already');
logout = false;
assert.equal(inspect().status, 'pending', 'Missing logout while loading is not proof of logged-out state');
login = true;
assert.equal(inspect().status, 'login');
assert.equal(click().ok, false);
assert.equal(clicks, 2);
console.log('KLPBBS old/new interface regression checks passed.');
