/* docs.js: docs-page chrome. Loaded after i18n.js/main.js (deferred), so its strings are
   merged into `translations` before main.js applies the language on DOMContentLoaded.
   Each docs page carries one <article class="doc-lang" lang="…"> per site language;
   docs.css shows the one matching html[lang].

   Heading anchors: every language marks section headings with data-anchor="<id>", and
   only the visible article owns the real id, so #deep-links work in every language.
   Keep anchor ids from starting with a language code (en, zh, ko, ja, pt): i18n.js still
   reads a legacy #<language> hash and would treat such a hash as a language switch. */
var docsStrings = {
  en: {
    "docs.nav": "Documentation",
    "docs.menu": "Docs menu",
    "docs.group.start": "Get started",
    "docs.group.plugins": "Plugins",
    "docs.group.build": "Build plugins",
    "docs.group.reference": "Author references",
    "docs.page.home": "Overview",
    "docs.page.app": "Using the App",
    "docs.page.plugins": "Using plugins",
    "docs.page.quickstart": "Plugin development guide",
    "docs.page.ui": "UI integration",
    "docs.page.data": "Data and settings",
    "docs.page.share": "Test and share",
    "docs.page.reference": "Plugin API reference",
    "docs.page.uiReference": "UI integration reference",
    "docs.page.distributionReference": "Distribution reference",
    "docs.page.dataReference": "Data and settings reference",
    "docs.page.resourcesReference": "Resource fields and coverage",
    "docs.page.publishingReference": "Publishing guide",
    "docs.page.testingReference": "Testing and acceptance",
    "docs.referenceLanguage": "Canonical reference · English source",
    "docs.referenceMarkdown": "Read source Markdown",
    "docs.referenceSource": "Source document",
    "docs.crumb": "Docs",
    "docs.toc": "On this page",
    "docs.prev": "Previous",
    "docs.next": "Next",
    "docs.pager": "Previous and next pages",
    "docs.copy": "Copy",
    "docs.copied": "Copied",
    "docs.copyLabel": "Copy code",
    "docs.copyPrompt": "Copy prompt",
    "docs.copyFallback": "Clipboard unavailable. Text selected; copy it with your keyboard.",
    "docs.titleSuffix": "Token Monitor Docs"
  },
  "zh-TW": {
    "docs.nav": "文件",
    "docs.menu": "文件目錄",
    "docs.group.start": "開始使用",
    "docs.group.plugins": "外掛",
    "docs.group.build": "開發外掛",
    "docs.group.reference": "作者參考文件",
    "docs.page.home": "總覽",
    "docs.page.app": "使用 App",
    "docs.page.plugins": "使用外掛",
    "docs.page.quickstart": "外掛開發指南",
    "docs.page.ui": "UI 整合",
    "docs.page.data": "資料與設定",
    "docs.page.share": "測試與分享",
    "docs.page.reference": "外掛 API 參考",
    "docs.page.uiReference": "UI 整合參考",
    "docs.page.distributionReference": "發佈參考",
    "docs.page.dataReference": "資料與設定參考",
    "docs.page.resourcesReference": "資源欄位與量測覆蓋",
    "docs.page.publishingReference": "發佈指南",
    "docs.page.testingReference": "測試與驗收",
    "docs.referenceLanguage": "參考文件原文（英文）",
    "docs.referenceMarkdown": "閱讀原始 Markdown",
    "docs.referenceSource": "原始文件",
    "docs.crumb": "文件",
    "docs.toc": "本頁內容",
    "docs.prev": "上一頁",
    "docs.next": "下一頁",
    "docs.pager": "上一頁與下一頁",
    "docs.copy": "複製",
    "docs.copied": "已複製",
    "docs.copyLabel": "複製程式碼",
    "docs.copyPrompt": "複製提示詞",
    "docs.copyFallback": "無法使用剪貼簿。已選取文字，請用鍵盤複製。",
    "docs.titleSuffix": "Token Monitor 文件"
  },
  "zh-CN": {
    "docs.nav": "文档",
    "docs.menu": "文档目录",
    "docs.group.start": "开始使用",
    "docs.group.plugins": "插件",
    "docs.group.build": "开发插件",
    "docs.group.reference": "作者参考文档",
    "docs.page.home": "概览",
    "docs.page.app": "使用 App",
    "docs.page.plugins": "使用插件",
    "docs.page.quickstart": "插件开发指南",
    "docs.page.ui": "UI 集成",
    "docs.page.data": "数据与设置",
    "docs.page.share": "测试与分享",
    "docs.page.reference": "插件 API 参考",
    "docs.page.uiReference": "UI 集成参考",
    "docs.page.distributionReference": "发布参考",
    "docs.page.dataReference": "数据与设置参考",
    "docs.page.resourcesReference": "资源字段与测量覆盖",
    "docs.page.publishingReference": "发布指南",
    "docs.page.testingReference": "测试与验收",
    "docs.referenceLanguage": "参考文档原文（英文）",
    "docs.referenceMarkdown": "阅读原始 Markdown",
    "docs.referenceSource": "原始文档",
    "docs.crumb": "文档",
    "docs.toc": "本页内容",
    "docs.prev": "上一页",
    "docs.next": "下一页",
    "docs.pager": "上一页与下一页",
    "docs.copy": "复制",
    "docs.copied": "已复制",
    "docs.copyLabel": "复制代码",
    "docs.copyPrompt": "复制提示词",
    "docs.copyFallback": "剪贴板不可用。文字已选中，请用键盘复制。",
    "docs.titleSuffix": "Token Monitor 文档"
  },
  ko: {
    "docs.nav": "문서",
    "docs.menu": "문서 메뉴",
    "docs.group.start": "시작하기",
    "docs.group.plugins": "플러그인",
    "docs.group.build": "플러그인 만들기",
    "docs.group.reference": "작성자 참조",
    "docs.page.home": "개요",
    "docs.page.app": "앱 사용하기",
    "docs.page.plugins": "플러그인 사용하기",
    "docs.page.quickstart": "플러그인 개발 가이드",
    "docs.page.ui": "UI 통합",
    "docs.page.data": "데이터와 설정",
    "docs.page.share": "테스트와 공유",
    "docs.page.reference": "플러그인 API 참조",
    "docs.page.uiReference": "UI 통합 참조",
    "docs.page.distributionReference": "배포 참조",
    "docs.page.dataReference": "데이터와 설정 참조",
    "docs.page.resourcesReference": "리소스 필드와 측정 범위",
    "docs.page.publishingReference": "게시 가이드",
    "docs.page.testingReference": "테스트와 인수 검증",
    "docs.referenceLanguage": "공식 참조 · 영어 원문",
    "docs.referenceMarkdown": "원본 Markdown 읽기",
    "docs.referenceSource": "원본 문서",
    "docs.crumb": "문서",
    "docs.toc": "이 페이지의 내용",
    "docs.prev": "이전",
    "docs.next": "다음",
    "docs.pager": "이전 및 다음 페이지",
    "docs.copy": "복사",
    "docs.copied": "복사됨",
    "docs.copyLabel": "코드 복사",
    "docs.copyPrompt": "프롬프트 복사",
    "docs.copyFallback": "클립보드를 사용할 수 없습니다. 텍스트를 선택했으니 키보드로 복사하세요.",
    "docs.titleSuffix": "Token Monitor 문서"
  },
  ja: {
    "docs.nav": "ドキュメント",
    "docs.menu": "ドキュメントのメニュー",
    "docs.group.start": "はじめに",
    "docs.group.plugins": "プラグイン",
    "docs.group.build": "プラグインを作る",
    "docs.group.reference": "作者向けリファレンス",
    "docs.page.home": "概要",
    "docs.page.app": "アプリの使い方",
    "docs.page.plugins": "プラグインの使い方",
    "docs.page.quickstart": "プラグイン開発ガイド",
    "docs.page.ui": "UI 統合",
    "docs.page.data": "データと設定",
    "docs.page.share": "テストと共有",
    "docs.page.reference": "プラグイン API リファレンス",
    "docs.page.uiReference": "UI 統合リファレンス",
    "docs.page.distributionReference": "配布リファレンス",
    "docs.page.dataReference": "データと設定のリファレンス",
    "docs.page.resourcesReference": "リソースのフィールドと測定範囲",
    "docs.page.publishingReference": "公開ガイド",
    "docs.page.testingReference": "テストと受け入れ検証",
    "docs.referenceLanguage": "正式なリファレンス · 英語原文",
    "docs.referenceMarkdown": "原文 Markdown を読む",
    "docs.referenceSource": "原文ドキュメント",
    "docs.crumb": "ドキュメント",
    "docs.toc": "このページの内容",
    "docs.prev": "前へ",
    "docs.next": "次へ",
    "docs.pager": "前後のページ",
    "docs.copy": "コピー",
    "docs.copied": "コピーしました",
    "docs.copyLabel": "コードをコピー",
    "docs.copyPrompt": "プロンプトをコピー",
    "docs.copyFallback": "クリップボードを利用できません。テキストを選択したので、キーボードでコピーしてください。",
    "docs.titleSuffix": "Token Monitor ドキュメント"
  },
  "pt-BR": {
    "docs.nav": "Documentação",
    "docs.menu": "Menu da documentação",
    "docs.group.start": "Primeiros passos",
    "docs.group.plugins": "Plugins",
    "docs.group.build": "Criar plugins",
    "docs.group.reference": "Referências para autores",
    "docs.page.home": "Visão geral",
    "docs.page.app": "Usando o app",
    "docs.page.plugins": "Usando plugins",
    "docs.page.quickstart": "Guia de desenvolvimento de plugins",
    "docs.page.ui": "Integração de UI",
    "docs.page.data": "Dados e configurações",
    "docs.page.share": "Testar e compartilhar",
    "docs.page.reference": "Referência da API de plugins",
    "docs.page.uiReference": "Referência de integração de UI",
    "docs.page.distributionReference": "Referência de distribuição",
    "docs.page.dataReference": "Referência de dados e configurações",
    "docs.page.resourcesReference": "Campos de recursos e cobertura",
    "docs.page.publishingReference": "Guia de publicação",
    "docs.page.testingReference": "Testes e aceitação",
    "docs.referenceLanguage": "Referência canônica · original em inglês",
    "docs.referenceMarkdown": "Ler Markdown original",
    "docs.referenceSource": "Documento original",
    "docs.crumb": "Docs",
    "docs.toc": "Nesta página",
    "docs.prev": "Anterior",
    "docs.next": "Próxima",
    "docs.pager": "Página anterior e próxima",
    "docs.copy": "Copiar",
    "docs.copied": "Copiado",
    "docs.copyLabel": "Copiar código",
    "docs.copyPrompt": "Copiar prompt",
    "docs.copyFallback": "Área de transferência indisponível. Texto selecionado; copie pelo teclado.",
    "docs.titleSuffix": "Documentação do Token Monitor"
  }
};

(function mergeDocsStrings() {
  if (typeof translations === "undefined") return;
  Object.keys(docsStrings).forEach(function (lang) {
    var target = translations[lang];
    if (!target) return;
    Object.keys(docsStrings[lang]).forEach(function (key) { target[key] = docsStrings[lang][key]; });
  });
})();

function docsMessages() {
  var lang = document.documentElement.lang;
  return (typeof translations !== "undefined" && translations[lang]) || translations.en;
}

function activeArticle() {
  var shared = document.querySelector("article[data-docs-shared]");
  if (shared) return shared;
  var articles = document.querySelectorAll("article.doc-lang");
  var lang = document.documentElement.lang;
  for (var i = 0; i < articles.length; i++) if (articles[i].getAttribute("lang") === lang) return articles[i];
  return articles[0] || null;
}

/* Move heading ids onto the visible article so in-page links and #hashes resolve. */
function assignAnchors(article) {
  var all = document.querySelectorAll("[data-anchor]");
  for (var i = 0; i < all.length; i++) all[i].removeAttribute("id");
  if (!article) return;
  var mine = article.querySelectorAll("[data-anchor]");
  for (var j = 0; j < mine.length; j++) mine[j].id = mine[j].getAttribute("data-anchor");
}

function buildTopicNav(article) {
  var topic = document.querySelector('.docs-nav a[aria-current="page"]');
  var old = document.querySelector('.docs-topic-links');
  if (old) old.remove();
  var headings = article ? Array.prototype.slice.call(article.querySelectorAll('h2[data-anchor], h3[data-anchor]')) : [];
  if (!topic || !headings.length) return headings;
  var list = document.createElement('ol');
  list.className = 'docs-topic-links';
  list.setAttribute('aria-label', docsMessages()['docs.toc']);
  var children = null;
  headings.forEach(function (heading) {
    var anchor = heading.getAttribute('data-anchor');
    var item = document.createElement('li');
    var link = document.createElement('a');
    link.href = '#' + encodeURIComponent(anchor);
    link.textContent = heading.textContent;
    item.appendChild(link);
    if (heading.tagName === 'H2') {
      item.className = 'docs-topic-chapter';
      item.setAttribute('data-chapter', anchor);
      children = document.createElement('ol');
      children.className = 'docs-topic-subsections';
      children.hidden = true;
      item.appendChild(children);
      list.appendChild(item);
    } else {
      item.className = 'docs-topic-subitem';
      (children || list).appendChild(item);
    }
  });
  topic.parentNode.appendChild(list);
  return headings;
}

var topicScrollListener = null;
function watchTopic(headings) {
  if (topicScrollListener) window.removeEventListener('scroll', topicScrollListener);
  var list = document.querySelector('.docs-topic-links');
  if (!headings.length || !list) return;
  var pending = false;
  function mark() {
    pending = false;
    var current = headings[0].getAttribute('data-anchor');
    var chapter = current;
    // A short final section may never reach the heading threshold.
    var scroller = document.scrollingElement || document.documentElement;
    var atBottom = window.scrollY > 0 && scroller.scrollHeight - window.innerHeight - window.scrollY <= 2;
    for (var i = 0; i < headings.length; i++) {
      if (!atBottom && headings[i].getBoundingClientRect().top > 170) break;
      current = headings[i].getAttribute('data-anchor');
      if (headings[i].tagName === 'H2') chapter = current;
    }
    list.querySelectorAll('.docs-topic-chapter').forEach(function (item) {
      var children = item.querySelector('.docs-topic-subsections');
      var active = item.getAttribute('data-chapter') === chapter;
      item.classList.toggle('is-current-chapter', active);
      // Keep a keyboard-focused subsection in the DOM until focus moves away.
      children.hidden = !active && !children.contains(document.activeElement);
    });
    list.querySelectorAll('a').forEach(function (link) {
      if (link.getAttribute('href') === '#' + encodeURIComponent(current)) {
        var changed = link.getAttribute('aria-current') !== 'location';
        link.setAttribute('aria-current', 'location');
        if (changed && window.innerWidth > 860) {
          var sidebar = link.closest('.docs-sidebar');
          if (!sidebar.contains(document.activeElement)) {
            var linkBox = link.getBoundingClientRect();
            var sidebarBox = sidebar.getBoundingClientRect();
            if (linkBox.top < sidebarBox.top + 34 || linkBox.bottom > sidebarBox.bottom - 24) {
              sidebar.scrollTop += linkBox.top - sidebarBox.top - sidebar.clientHeight / 3;
            }
          }
        }
      } else link.removeAttribute('aria-current');
    });
  }
  topicScrollListener = function () {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(mark);
  };
  window.addEventListener('scroll', topicScrollListener, { passive: true });
  window.addEventListener('resize', topicScrollListener, { passive: true, once: true });
  list.addEventListener('focusout', function () { window.setTimeout(mark, 0); });
  mark();
}

function setupCopyButtons() {
  document.querySelectorAll('.code').forEach(function (block) {
    var head = block.querySelector('.code-head');
    var pre = block.querySelector('pre');
    if (!head || !pre) return;
    if (!pre.hasAttribute('tabindex')) pre.tabIndex = 0;
    var prompt = block.classList.contains('prompt-card');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.setAttribute('data-i18n-attr', 'aria-label:' + (prompt ? 'docs.copyPrompt' : 'docs.copyLabel'));
    var copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
    var checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    btn.innerHTML = copyIcon;
    btn.setAttribute('aria-label', docsMessages()[prompt ? 'docs.copyPrompt' : 'docs.copyLabel']);
    var status = document.createElement('span');
    status.className = 'code-copy-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    block.appendChild(status);
    var timer = null;
    function fallback() {
      clearTimeout(timer);
      btn.innerHTML = copyIcon;
      status.classList.remove('copy-success');
      pre.focus();
      var range = document.createRange();
      range.selectNodeContents(pre);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = docsMessages()['docs.copyFallback'];
    }
    btn.addEventListener('click', function () {
      var value = pre.textContent.replace(/\n$/, '');
      if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
      navigator.clipboard.writeText(value).then(function () {
        status.classList.add('copy-success');
        status.textContent = docsMessages()['docs.copied'];
        btn.innerHTML = checkIcon;
        clearTimeout(timer);
        timer = setTimeout(function () { btn.innerHTML = copyIcon; status.textContent = ''; }, 1600);
      }, fallback);
    });
    head.appendChild(btn);
  });
}

function setupDocsMenu() {
  var btn = document.querySelector(".docs-menu-btn");
  var nav = document.getElementById("docs-nav");
  if (!btn || !nav) return;
  nav.setAttribute("data-collapsed", "");
  btn.addEventListener("click", function () {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    if (open) nav.setAttribute("data-collapsed", "");
    else nav.removeAttribute("data-collapsed");
  });
  nav.addEventListener('click', function (event) {
    if (!event.target.closest('a[href^="#"]') || window.innerWidth > 860) return;
    nav.setAttribute('data-collapsed', '');
    btn.setAttribute('aria-expanded', 'false');
  });
}

function redirectLegacyGuide() {
  var legacy = document.body.getAttribute('data-docs-legacy');
  var chapters = { ui: 'interface', data: 'data-settings', share: 'test-distribute' };
  var id;
  try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (e) { id = ''; }
  if (!legacy) {
    var previous = /^(ui|data|share)-(.*)$/.exec(id);
    if (!/\/plugin-quickstart\.html$/.test(window.location.pathname) || !previous) return false;
    legacy = previous[1];
    id = previous[2];
  }
  var sections = {
    ui: { choose: 'content-surfaces', example: 'original-content-targets', lifecycle: 'lifecycle-and-appearance', reference: 'content-surfaces', 'render-choice': 'content-surfaces', 'rich-failures': 'lifecycle-and-appearance' },
    data: { permissions: 'execution-and-trust', 'data-decision': 'host-data-and-settings', paging: 'host-data-and-settings', relations: 'host-data-and-settings', settings: 'host-data-and-settings', 'plugin-settings': 'host-data-and-settings', 'settings-conflicts': 'host-data-and-settings' },
    share: { catalog: 'create-a-community-catalog', 'catalog-trust': 'optional-ed25519-signing', package: 'package-format', reference: 'catalogs', 'release-check': 'test-before-sharing', test: 'test-before-sharing' }
  };
  var references = { ui: 'plugin-ui-reference.html', data: 'plugin-reference.html', share: 'plugin-distribution-reference.html' };
  var section = sections[legacy] && Object.prototype.hasOwnProperty.call(sections[legacy], id) ? sections[legacy][id] : null;
  var url = new URL(section ? references[legacy] : 'plugin-quickstart.html', window.location.href);
  var target = section || chapters[legacy];
  url.search = window.location.search;
  url.hash = target;
  window.location.replace(url.href);
  return true;
}

function scrollToHash() {
  if (!window.location.hash) return;
  var id;
  try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (e) { return; }
  var target = document.getElementById(id);
  if (target) target.scrollIntoView();
}

function refreshDocs(scroll) {
  var article = activeArticle();
  var language = document.documentElement.lang;
  document.querySelectorAll('a[href]').forEach(function (link) {
    var url = new URL(link.getAttribute('href'), window.location.href);
    if (url.origin === window.location.origin && !link.getAttribute('href').startsWith('#')) {
      url.searchParams.set('lang', language);
      link.href = url.href;
    }
  });
  assignAnchors(article);
  watchTopic(buildTopicNav(article));
  var h1 = article && article.querySelector("h1");
  var suffix = docsMessages()["docs.titleSuffix"];
  if (h1) document.title = document.body.hasAttribute("data-docs-home") ? suffix : h1.textContent + " · " + suffix;
  if (scroll) scrollToHash();
}

var docsReady = false;
window.addEventListener("token-monitor-languagechange", function () { if (docsReady) refreshDocs(true); });
document.addEventListener("DOMContentLoaded", function () {
  // main.js's DOMContentLoaded handler (registered first) has applied the language.
  if (redirectLegacyGuide()) return;
  docsReady = true;
  setupCopyButtons();
  setupDocsMenu();
  refreshDocs(true);
});
