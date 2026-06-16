/**
 * Margin Guard — shared app shell (sidebar + simplified topbar).
 * Pilot: pages with data-mg-app-nav on <body>.
 */
(function () {
  const PIN_KEY = 'mg_nav_pinned_v1';

  const NAV_GROUPS = [
    {
      label: 'Main',
      items: [
        { type: 'link', href: '/dashboard', label: 'Dashboard', icon: 'DB' },
        { type: 'link', href: '/estimates-invoices', label: 'Invoices Hub', icon: 'IH' }
      ]
    },
    {
      label: 'Operations',
      ownerOnly: true,
      items: [
        { type: 'link', href: '/owner', label: 'Dueno', icon: 'DU', ownerNav: true },
        { type: 'link', href: '/sales', label: 'Vendedor', icon: 'VE', ownerNav: true },
        { type: 'link', href: '/supervisor', label: 'Supervisor', icon: 'SU', ownerNav: true },
        { type: 'link', href: '/project-control', label: 'Project Control', icon: 'PC', ownerNav: true },
        { type: 'link', href: '/sales-admin', label: 'Sales Admin', icon: 'SA', ownerNav: true }
      ]
    },
    {
      label: 'Business Setup',
      ownerOnly: true,
      items: [
        { type: 'link', href: '/business-settings', label: 'Business Settings', icon: 'BS', ownerNav: true },
        { type: 'link', href: '/team-devices', label: 'Team & Devices', icon: 'TD', ownerNav: true }
      ]
    },
    {
      label: 'Account',
      ownerOnly: true,
      items: [
        { type: 'button', id: 'btnManagePlan', label: 'Gestionar plan', icon: 'PL', ownerNav: true },
        { type: 'button', id: 'btnLogout', label: 'Cerrar sesión', icon: 'LO', danger: true, ownerNav: true }
      ]
    }
  ];

  function normalizePath(path) {
    let p = String(path || '/').split('?')[0].split('#')[0];
    if (p.endsWith('.html')) p = p.slice(0, -5);
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p || '/';
  }

  function isActiveHref(href) {
    const current = normalizePath(window.location.pathname);
    const target = normalizePath(href);
    if (current === target) return true;
    if (target === '/dashboard' && (current === '/' || current === '/app')) return true;
    return false;
  }

  function canFinePointerHover() {
    return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }

  function isDesktopShell() {
    return window.matchMedia('(min-width: 1200px)').matches;
  }

  function readPinned() {
    try {
      return localStorage.getItem(PIN_KEY) === 'true';
    } catch (_e) {
      return false;
    }
  }

  function writePinned(value) {
    try {
      localStorage.setItem(PIN_KEY, value ? 'true' : 'false');
    } catch (_e) {}
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderNavGroups() {
    return NAV_GROUPS.map(function (group) {
      const groupAttr = group.ownerOnly ? ' data-owner-nav' : '';
      const itemsHtml = group.items.map(function (item) {
        const ownerAttr = item.ownerNav ? ' data-owner-nav' : '';
        const activeClass = item.type === 'link' && isActiveHref(item.href) ? ' mg-sidebar__item--active' : '';
        const dangerClass = item.danger ? ' mg-sidebar__item--danger' : '';
        const icon = '<span class="mg-sidebar__icon" aria-hidden="true">' + escapeHtml(item.icon) + '</span>';
        const label = '<span class="mg-sidebar__label">' + escapeHtml(item.label) + '</span>';
        if (item.type === 'link') {
          return (
            '<a class="mg-sidebar__item' + activeClass + '"' + ownerAttr +
            ' href="' + escapeHtml(item.href) + '">' + icon + label + '</a>'
          );
        }
        const btnClass = item.danger ? 'btn danger' : 'btn';
        return (
          '<button type="button" class="mg-sidebar__item mg-sidebar__item--btn ' + btnClass + dangerClass + '"' +
          ' id="' + escapeHtml(item.id) + '"' + ownerAttr + '>' + icon + label + '</button>'
        );
      }).join('');
      return (
        '<div class="mg-sidebar__group"' + groupAttr + '>' +
        '<div class="mg-sidebar__group-label">' + escapeHtml(group.label) + '</div>' +
        itemsHtml +
        '</div>'
      );
    }).join('');
  }

  function collectPageNodes(body) {
    const nodes = [];
    Array.from(body.childNodes).forEach(function (node) {
      if (node.nodeName === 'SCRIPT') return;
      if (node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('topbar')) return;
      nodes.push(node);
    });
    return nodes;
  }

  function setDrawerOpen(body, open) {
    body.classList.toggle('mg-nav-drawer-open', !!open);
    const overlay = document.getElementById('mgSidebarOverlay');
    const menuBtn = document.getElementById('mgMobileMenuButton');
    if (overlay) overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setHoverExpanded(body, expanded) {
    if (!canFinePointerHover() || !isDesktopShell()) return;
    body.classList.toggle('mg-sidebar-hover-expand', !!expanded);
  }

  function syncPinnedUi(body, pinned) {
    body.classList.toggle('mg-sidebar-pinned', !!pinned);
    const pinBtn = document.getElementById('mgSidebarPin');
    if (pinBtn) {
      pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      pinBtn.title = pinned ? 'Unpin sidebar' : 'Pin sidebar';
    }
  }

  function buildShell(body) {
    const pageTitle = body.getAttribute('data-mg-page-title') || 'Margin Guard';
    const pinned = readPinned();

    const sidebar = document.createElement('aside');
    sidebar.className = 'mg-sidebar';
    sidebar.id = 'mgAppSidebar';
    sidebar.setAttribute('aria-label', 'Main navigation');
    sidebar.innerHTML =
      '<div class="mg-sidebar__header">' +
      '  <a class="mg-sidebar__brand" href="/dashboard" aria-label="Margin Guard home">' +
      '    <span class="mg-sidebar__brand-mark">MG</span>' +
      '    <span class="mg-sidebar__brand-text">Margin Guard</span>' +
      '  </a>' +
      '  <button type="button" class="mg-sidebar__pin" id="mgSidebarPin" aria-label="Pin sidebar" aria-pressed="false" title="Pin sidebar">' +
      '    <span aria-hidden="true">📌</span>' +
      '  </button>' +
      '</div>' +
      '<nav class="mg-sidebar__nav">' + renderNavGroups() + '</nav>' +
      '<div class="mg-sidebar__footer" data-owner-nav>' +
      '  <p class="mg-sidebar__plan" id="planStatus">Validando suscripcion...</p>' +
      '</div>';

    const overlay = document.createElement('div');
    overlay.className = 'mg-sidebar-overlay';
    overlay.id = 'mgSidebarOverlay';
    overlay.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'mg-app-main';
    main.id = 'mgAppMain';

    const topbar = document.createElement('header');
    topbar.className = 'mg-topbar';
    topbar.innerHTML =
      '<div class="mg-topbar__inner">' +
      '  <button type="button" class="mg-mobile-menu-button" id="mgMobileMenuButton" aria-label="Open navigation" aria-expanded="false" aria-controls="mgAppSidebar">' +
      '    <span class="mg-mobile-menu-button__bar"></span>' +
      '    <span class="mg-mobile-menu-button__bar"></span>' +
      '    <span class="mg-mobile-menu-button__bar"></span>' +
      '  </button>' +
      '  <h1 class="mg-topbar__title">' + escapeHtml(pageTitle) + '</h1>' +
      '</div>';

    const mainBody = document.createElement('div');
    mainBody.className = 'mg-app-main__body';

    const pageNodes = collectPageNodes(body);
    pageNodes.forEach(function (node) {
      mainBody.appendChild(node);
    });

    main.appendChild(topbar);
    main.appendChild(mainBody);

    body.classList.add('mg-app-shell');
    body.insertBefore(sidebar, body.firstChild);
    body.insertBefore(overlay, body.firstChild.nextSibling);
    body.insertBefore(main, overlay.nextSibling);

    syncPinnedUi(body, pinned);

    const pinBtn = document.getElementById('mgSidebarPin');
    pinBtn?.addEventListener('click', function (event) {
      event.preventDefault();
      const next = !body.classList.contains('mg-sidebar-pinned');
      writePinned(next);
      syncPinnedUi(body, next);
      setHoverExpanded(body, false);
    });

    sidebar.addEventListener('mouseenter', function () {
      if (body.classList.contains('mg-sidebar-pinned')) return;
      setHoverExpanded(body, true);
    });
    sidebar.addEventListener('mouseleave', function () {
      setHoverExpanded(body, false);
    });

    document.getElementById('mgMobileMenuButton')?.addEventListener('click', function () {
      setDrawerOpen(body, !body.classList.contains('mg-nav-drawer-open'));
    });

    overlay.addEventListener('click', function () {
      setDrawerOpen(body, false);
    });

    sidebar.querySelectorAll('a.mg-sidebar__item').forEach(function (link) {
      link.addEventListener('click', function () {
        if (!isDesktopShell()) setDrawerOpen(body, false);
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (body.classList.contains('mg-nav-drawer-open')) setDrawerOpen(body, false);
    });

    window.addEventListener('resize', function () {
      if (isDesktopShell()) setDrawerOpen(body, false);
      if (!canFinePointerHover()) setHoverExpanded(body, false);
    });
  }

  function init() {
    const body = document.body;
    if (!body || !body.hasAttribute('data-mg-app-nav')) return;
    if (body.dataset.mgAppNavReady === 'true') return;
    body.dataset.mgAppNavReady = 'true';
    buildShell(body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
