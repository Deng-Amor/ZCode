const menuButton = document.querySelector<HTMLButtonElement>('.menu-toggle');
const navigation = document.querySelector<HTMLElement>('#main-navigation');
function closeMenu() {
  menuButton?.setAttribute('aria-expanded', 'false');
  navigation?.classList.remove('is-open');
}
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  navigation?.classList.toggle('is-open', open);
});
navigation?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuButton.focus();
  }
});
document.querySelector('.theme-toggle')?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ccode-theme', theme); } catch { /* 无持久化权限时仍可切换当前页面。 */ }
});

const demos = {
  website: { title: '搭建产品官网', file: '产品官网', prompt: '帮我做一个产品官网，能展示功能，也能下载安装包。', reply: '先把想法拆成清晰的步骤，再一起完成。', steps: ['明确产品定位与页面结构', '完成桌面与手机端页面', '检查下载与交互，交付结果'] },
  project: { title: '整理项目结构', file: '项目结构说明', prompt: '帮我梳理这个项目，看看目录结构和使用说明该怎么整理。', reply: '先了解现有项目，再给出可检查的整理方案。', steps: ['阅读项目结构与已有说明', '整理模块职责和使用步骤', '核对变更，补充项目文档'] },
  review: { title: '检查代码问题', file: '代码检查报告', prompt: '帮我检查这段代码，找出问题并说明修复思路。', reply: '结合代码和验证结果，让每个结论都有依据。', steps: ['了解预期行为与复现条件', '定位问题，提出修改方案', '验证修复并说明检查结果'] },
};
document.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((button) => {
  button.addEventListener('click', () => {
    const demo = demos[button.dataset.demo as keyof typeof demos];
    if (!demo) return;
    document.querySelectorAll('[data-demo]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    for (const key of ['title', 'prompt', 'reply'] as const) {
      const element = document.querySelector(`[data-demo-${key}]`);
      if (element) element.textContent = demo[key];
    }
    document.querySelectorAll('[data-demo-step]').forEach((item, index) => { item.textContent = demo.steps[index]; });
    // 场景切换同时更新产物，避免项目/代码任务仍展示网站产物。
    const fileTitle = document.querySelector('[data-demo-file-title]');
    if (fileTitle) fileTitle.textContent = demo.file;
  });
});

document.querySelector<HTMLButtonElement>('[data-copy-url]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const url = new URL(button.dataset.copyUrl!, location.origin).href;
  const feedback = document.querySelector<HTMLElement>('.copy-feedback');
  const input = document.querySelector<HTMLInputElement>('#download-url');
  const status = document.querySelector<HTMLElement>('[data-copy-status]');
  if (!feedback || !input || !status) return;
  feedback.hidden = false;
  input.value = url;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const suffix = local ? ' 当前是本机预览地址，其他设备无法直接使用。' : ' 请在 Windows 电脑上打开。';
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = `下载链接已复制。${suffix}`;
  } catch {
    status.textContent = `请手动复制下方地址。${suffix}`;
    input.focus();
    input.select();
  }
});
