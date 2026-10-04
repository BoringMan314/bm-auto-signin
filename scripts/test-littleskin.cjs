const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
let clicks = 0, login = false, logout = true, spinner = false, captcha = null;
const button = { textContent: '簽到', disabled: false, querySelector: () => spinner ? {} : null, click: () => clicks++ };
const context = vm.createContext({
  window: { blessing: { user: { uid: 1 } } }, location: { href: 'https://littleskin.cn/user' },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  document: {
    getElementById: () => logout ? {} : null,
    querySelector: s => s === '.geetest_panel' ? captcha : s.includes('#usage-box') ? button : login ? {} : null
  }
});
vm.runInContext(source.slice(source.indexOf('function littleSkinSignAction('), source.indexOf('async function inspectLittleSkin(')), context);
const inspect = () => vm.runInContext('littleSkinSignAction()', context);
const click = () => vm.runInContext('littleSkinSignAction(true)', context);
assert.equal(inspect().status, 'need');
assert.equal(click().ok, true);
assert.equal(clicks, 1);
button.disabled = true; spinner = true;
assert.equal(click().status, 'pending');
spinner = false;
assert.equal(inspect().status, 'pending', 'Disabled sign-in alone is not completion');
for (const text of ['在 23 時 后可用', '在 1 小時 後可用', '在 23 小时后可用', 'Available in 23 hours']) {
  button.textContent = text;
  assert.equal(click().status, 'already');
}
button.disabled = false;
assert.equal(click().status, 'pending', 'Cooldown must also be disabled');
assert.equal(clicks, 1);
logout = false;
assert.equal(inspect().status, 'pending', 'Incomplete loading is not logged out');
login = true;
assert.equal(click().status, 'login');
login = false; context.location.href = 'https://littleskin.cn/auth/login';
assert.equal(inspect().status, 'login');
logout = true; button.textContent = '簽到';
captcha = { textContent: '', getClientRects: () => [1], querySelector: s => s === '.geetest_panel_box' ? { className: 'geetest_panelshowslide' } : null };
assert.equal(click().status, 'captcha');
assert.equal(clicks, 1, 'Do not click through a CAPTCHA or completed sign-in');
console.log('LittleSkin login, loading, cooldown, and guarded click checks passed.');
