/**
 * Margin Guard — sidebar shell smoke (Sales Admin + Invoices Hub).
 * Run: node scripts/smoke/mg-sidebar-shell-smoke.cjs
 * Optional: BASE_URL=https://marginguardsystem.netlify.app node scripts/smoke/mg-sidebar-shell-smoke.cjs
 */
const puppeteer = require('puppeteer');
const { getVisibleReachableHelperSource } = require('./mg-smoke-visible.cjs');

const BASE = process.env.BASE_URL || 'https://marginguardsystem.netlify.app';
const T = Number(process.env.SMOKE_TIMEOUT_MS || 20000);

const PAGE_CONTROL_SELECTOR =
  '.mg-app-main button, .mg-app-main a.btn, .mg-app-main input:not([type="hidden"]), .mg-app-main select, .mg-app-main textarea';

const PAGES = {
  'sales-admin': {
    path: '/sales-admin',
    title: 'Sales Admin',
    activeSel: 'a.mg-sidebar__item--active[href="/sales-admin"]',
    contentSel: '#saKpiStrip',
  },
  'estimates-invoices': {
    path: '/estimates-invoices',
    title: 'Invoices Hub',
    activeSel: 'a.mg-sidebar__item--active[href="/estimates-invoices"]',
    contentSel: '#hubHeroTotal',
    extra: async (page) => {
      if (!(await page.$('#hubDrawer'))) throw new Error('hub drawer missing');
      const z = await page.evaluate(() => {
        const d = document.getElementById('hubDrawer');
        d.setAttribute('aria-hidden', 'false');
        return {
          modal: parseInt(getComputedStyle(d).zIndex, 10) || 0,
          sidebar: parseInt(getComputedStyle(document.getElementById('mgAppSidebar')).zIndex, 10) || 0,
        };
      });
      if (z.modal <= z.sidebar) throw new Error('hub drawer blocked by sidebar: ' + JSON.stringify(z));
      await page.evaluate(() => document.getElementById('hubDrawer')?.setAttribute('aria-hidden', 'true'));
      if (!(await page.$('#hubClientModal'))) throw new Error('hub client modal missing');
    },
  },
};

async function mockAuth(page) {
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/.netlify/functions/')) {
      let body = JSON.stringify({ ok: true });
      if (u.includes('auth-status')) {
        body = JSON.stringify({ active: true, is_admin: true, email: 'smoke@test.com' });
      }
      if (u.includes('owner-settings-deposit-link')) {
        body = JSON.stringify({
          ok: true,
          deposit_payment_link: null,
          payment_instructions: '',
          payment_link: null,
        });
      }
      r.respond({ status: 200, contentType: 'application/json', body });
    } else {
      r.continue();
    }
  });
}

async function assertMobileButtonsReachable(page, fail, pass) {
  const helperSource = getVisibleReachableHelperSource();
  const result = await page.evaluate(
    (selector, helperSrc) => {
      const helper = eval(helperSrc);
      const main = document.querySelector('.mg-app-main');
      const scope = main || document;
      const candidates = [...scope.querySelectorAll(selector)];
      const visible = candidates.filter(helper);
      return {
        count: visible.length,
        samples: visible.slice(0, 5).map((el) => ({
          id: el.id || null,
          tag: el.tagName,
          className: el.className || '',
          width: Math.round(el.getBoundingClientRect().width),
          height: Math.round(el.getBoundingClientRect().height),
        })),
        hiddenPrimary: candidates
          .filter((el) => el.id === 'pccBtnSetBaseline' || el.classList.contains('primary'))
          .map((el) => ({
            id: el.id,
            width: Math.round(el.getBoundingClientRect().width),
            height: Math.round(el.getBoundingClientRect().height),
            visible: helper(el),
          })),
      };
    },
    PAGE_CONTROL_SELECTOR,
    helperSource
  );

  if (result.count < 1) {
    fail('buttons reachable', JSON.stringify(result));
  }
  pass('buttons reachable', `${result.count} visible (${JSON.stringify(result.samples)})`);
}

async function runPage(name, viewport, label, opts = {}) {
  const cfg = PAGES[name];
  let browser;
  const checks = [];
  const pass = (step, note) => checks.push({ step, status: 'PASS', note: note || '' });
  const fail = (step, note) => {
    checks.push({ step, status: 'FAIL', note });
    throw new Error(step + ': ' + note);
  };

  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: T });
    const page = await browser.newPage();
    page.setDefaultTimeout(T);
    await page.setViewport(viewport);
    await mockAuth(page);

    const res = await page.goto(BASE + cfg.path, { waitUntil: 'domcontentloaded', timeout: T });
    if (!res || res.status() !== 200) fail('page loads', 'HTTP ' + (res && res.status()));
    pass('page loads', 'HTTP 200');

    await page.waitForSelector('body.mg-app-shell', { timeout: T });
    pass('sidebar shell appears');
    await page.waitForSelector('body.auth-ready', { timeout: T });

    if (!(await page.$(cfg.activeSel))) fail('active state highlighted', name);
    pass('active state highlighted');
    if (await page.$('.topbar')) fail('legacy topbar gone', 'present');
    pass('legacy topbar gone');

    const title = await page.$eval('.mg-topbar__title', (el) => el.textContent.trim()).catch(() => '');
    if (title !== cfg.title) fail('topbar title', title);
    pass('topbar title', title);

    if (!(await page.$(cfg.contentSel))) fail('content loads', cfg.contentSel);
    pass('content loads');

    if (cfg.extra) await cfg.extra(page);

    if (opts.desktop) {
      await page.hover('#mgAppSidebar');
      await new Promise((r) => setTimeout(r, 200));
      if (!(await page.evaluate(() => document.body.classList.contains('mg-sidebar-hover-expand')))) {
        fail('hover expand', 'false');
      }
      pass('hover expand works');
      await page.click('#mgSidebarPin');
      await new Promise((r) => setTimeout(r, 150));
      if (!(await page.evaluate(() => document.body.classList.contains('mg-sidebar-pinned')))) {
        fail('pin works', 'false');
      }
      pass('pin/unpin works');
    }

    if (opts.tablet || opts.mobile) {
      const ham = await page.evaluate(() => {
        const el = document.getElementById('mgMobileMenuButton');
        return el && getComputedStyle(el).display !== 'none';
      });
      if (!ham) fail('hamburger visible', 'hidden');
      pass('hamburger visible');

      await page.click('#mgMobileMenuButton');
      await new Promise((r) => setTimeout(r, 200));
      if (!(await page.evaluate(() => document.body.classList.contains('mg-nav-drawer-open')))) {
        fail('drawer opens', 'false');
      }
      pass('drawer opens');

      if (opts.mobile) {
        const dims = await page.evaluate(() => ({
          h: document.getElementById('mgAppSidebar').getBoundingClientRect().height,
          vh: window.innerHeight,
        }));
        if (dims.h < dims.vh * 0.9) fail('drawer full height', String(Math.round(dims.h)));
        pass('drawer full height', String(Math.round(dims.h)));

        if (
          !(await page.evaluate(() => {
            const n = document.querySelector('.mg-sidebar__nav');
            return n && n.scrollHeight >= n.clientHeight;
          }))
        ) {
          fail('nav scrolls internally', 'false');
        }
        pass('nav scrolls internally');
      }

      await page.click('#mgSidebarOverlay');
      await new Promise((r) => setTimeout(r, 150));
      if (await page.evaluate(() => document.body.classList.contains('mg-nav-drawer-open'))) {
        fail('overlay closes drawer', 'still open');
      }
      pass('overlay closes drawer');

      await page.click('#mgMobileMenuButton');
      await new Promise((r) => setTimeout(r, 150));
      await page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 150));
      if (await page.evaluate(() => document.body.classList.contains('mg-nav-drawer-open'))) {
        fail('ESC closes drawer', 'still open');
      }
      pass('ESC closes drawer');
    }

    if (opts.mobile) {
      await assertMobileButtonsReachable(page, fail, pass);
    }

    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)) {
      fail('no horizontal overflow', 'overflow');
    }
    pass('no horizontal overflow');

    await browser.close();
    return { page: name, viewport: label, result: 'PASS', checks };
  } catch (e) {
    if (browser) await browser.close();
    return { page: name, viewport: label, result: 'FAIL', error: String(e.message || e), checks };
  }
}

(async () => {
  const results = [];
  for (const name of Object.keys(PAGES)) {
    results.push(await runPage(name, { width: 1440, height: 900 }, 'desktop-1440', { desktop: true }));
    results.push(await runPage(name, { width: 900, height: 800 }, 'tablet-900', { tablet: true }));
    results.push(await runPage(name, { width: 390, height: 844 }, 'mobile-390', { mobile: true, tablet: true }));
  }

  const fails = results.filter((r) => r.result === 'FAIL');
  const summary = {
    baseUrl: BASE,
    pass: results.length - fails.length,
    fail: fails.length,
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
