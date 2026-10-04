const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const background = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const content = fs.readFileSync(path.join(__dirname, '../content-eyny.js'), 'utf8');

async function main() {
  let logout = false, account = false, login = true, shell = true, notice = '';
  const document = {
    body: { innerText: '' },
    querySelector(selector) {
      if (selector.includes('action=logout')) return logout ? {} : null;
      if (selector.includes('.vwmy')) return account ? { textContent: 'TestUser' } : null;
      if (selector.includes('action=login')) return login ? {} : null;
      return shell ? {} : null;
    },
    querySelectorAll: () => notice ? [{ textContent: notice }] : []
  };
  const context = vm.createContext({
    document, window: {}, location: { href: 'https://www52.eyny.com/' },
    chrome: { scripting: { executeScript: async ({ func }) => [{ result: func() }] } }
  });
  vm.runInContext(background.slice(background.indexOf('async function inspectEyny('), background.indexOf('async function drawKlpbbsThread(')), context);
  const inspect = () => vm.runInContext('inspectEyny(1)', context);
  assert.equal((await inspect()).status, 'login');
  logout = true;
  assert.equal((await inspect()).status, 'pending', 'Partial header must wait');
  account = true;
  assert.equal((await inspect()).status, 'ready', 'Account + logout proves login, not a reward');
  notice = '積分: 271';
  assert.equal((await inspect()).status, 'ready', 'Existing balance is not a reward');
  notice = '今日已簽到';
  assert.equal((await inspect()).status, 'already');
  logout = account = false;
  assert.equal((await inspect()).status, 'login', 'Notice cannot override logged-out header');
  shell = false;
  document.body.innerText = '瀏覽器安全檢查中';
  assert.equal((await inspect()).status, 'pending');

  let observer, clock = 0, reply = 'ready';
  const results = [];
  const root = { nodeType: 1, matches: () => false, closest: () => null, querySelectorAll: () => [] };
  const contentContext = vm.createContext({
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { clock += ms; fn(); },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
    document: { readyState: 'loading', documentElement: root, addEventListener() {} },
    window: { getComputedStyle: () => ({ position: 'static' }) },
    chrome: {
      i18n: { getMessage: key => key },
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async msg => {
          if (msg.type === 'eynyInspect') return { status: reply };
          if (msg.type === 'signResult') results.push(msg.payload);
          return {};
        }
      }
    }
  });
  vm.runInContext(content.replace(/\}\)\(\);\s*$/, 'globalThis.testApi = { inspect, runSignIn }; })();'), contentContext);
  await contentContext.testApi.runSignIn();
  assert.equal(results.pop().status, 'already', 'Verified login completes EYNY even when its toast is gone');
  const text = { nodeType: 3, textContent: '簽到成功', parentElement: root };
  observer([{ target: root, addedNodes: [text], removedNodes: [] }]);
  assert.equal((await contentContext.testApi.inspect()).status, 'already', 'Verified login does not require a notice');
  const toast = { ...root, textContent: '簽到成功', matches: () => true };
  observer([{ target: root, addedNodes: [], removedNodes: [toast] }]);
  assert.equal((await contentContext.testApi.inspect()).status, 'already', 'Removed flash must be retained');
  reply = 'pending';
  assert.equal((await contentContext.testApi.inspect()).status, 'pending');
  reply = 'login';
  assert.equal((await contentContext.testApi.inspect()).status, 'login');
  reply = 'ready';
  await contentContext.testApi.runSignIn();
  assert.equal(results.pop().status, 'already');
  console.log('EYNY login, reward, transient notice, and timeout regression checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
