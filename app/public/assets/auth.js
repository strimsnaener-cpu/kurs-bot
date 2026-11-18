// Client logic for auth pages and the dashboard. All user data is written with textContent (no innerHTML).
const pages = {
  register() {
    const err = $('.alert.err');
    onSubmit($('form'), async d => {
      hide(err);
      try { await api('/api/auth/register', d); location.href = safeNext(params.get('next')) || 'dashboard.html'; } catch (e) { showError(err, e); }
    });
  },

  login() {
    const err = $('.alert.err'), codeField = $('[data-2fa]');
    onSubmit($('form'), async d => {
      hide(err);
      if (codeField.hidden) delete d.code;
      try { await api('/api/auth/login', d); location.href = safeNext(params.get('next')) || 'dashboard.html'; }
      catch (e) {
        if (e.data?.needs2fa && codeField.hidden) { codeField.hidden = false; $('#code').focus(); return; }
        showError(err, e);
      }
    });
  },

  reset() {
    const token = takeToken();
    if (token) { $('[data-step="request"]').hidden = true; $('[data-step="set"]').hidden = false; }
    const reqStep = $('[data-step="request"]');
    onSubmit($('[data-form="request"]'), async d => {
      hide($('.alert.err', reqStep));
      try { const r = await api('/api/auth/request-password-reset', d); const ok = $('.alert.ok', reqStep); ok.textContent = r.message; ok.hidden = false; }
      catch (e) { showError($('.alert.err', reqStep), e); }
    });
    const setStep = $('[data-step="set"]');
    onSubmit($('[data-form="set"]'), async d => {
      hide($('.alert.err', setStep));
      try { await api('/api/auth/reset-password', { ...d, token }); location.href = 'login.html?reset=1'; }
      catch (e) { showError($('.alert.err', setStep), e); }
    });
  },

  async verify() {
    const msg = $('[data-msg]'), h1 = $('h1');
    const token = takeToken();
    try {
      if (!token) throw new Error('В ссылке не хватает кода. Откройте ссылку из письма ещё раз.');
      await api('/api/auth/verify-email', { token });
      h1.textContent = 'Email подтверждён'; msg.textContent = 'Спасибо! Ваш email подтверждён.';
    } catch (e) { h1.textContent = "Не удалось подтвердить email"; msg.textContent = e.message; }
  },

  async dashboard() {
    let me;
    try { me = await api('/api/me'); } catch (e) { if (e.status === 401) location.replace('login.html'); return; }
    const u = me.user, flash = $('[data-flash]');
    const say = text => { flash.textContent = text; flash.hidden = false; };
    $$('[data-name]').forEach(el => el.textContent = u.name.split(' ')[0]);
    $$('[data-email]').forEach(el => el.textContent = u.email);
    $('[data-role]').textContent = ROLE_RU[u.role] || u.role;
    if (u.role === 'ADMIN') $('[data-admin-link]').hidden = false;
    $('[data-org]').textContent = me.organizations[0]?.name || 'Рабочее пространство';
    $('[data-since]').textContent = new Date(u.createdAt).toLocaleDateString('ru-RU');
    const vb = $('[data-verified-badge]');
    vb.className = 'badge ' + (u.emailVerified ? 'on' : 'off');
    vb.textContent = u.emailVerified ? '● Подтверждён' : 'Не подтверждён';
    $('[data-verify]').hidden = u.emailVerified;

    $('[data-action="resend"]').addEventListener('click', async e => {
      e.target.disabled = true;
      try { await api('/api/auth/resend-verification', {}); say('Мы отправили новую ссылку для подтверждения.'); }
      catch (err) { say(err.message); }
    });

    // 2FA
    const err2 = $('[data-2fa-err]');
    const show2fa = state => { $('[data-2fa-off]').hidden = state !== 'off'; $('[data-2fa-setup]').hidden = state !== 'setup'; $('[data-2fa-on]').hidden = state !== 'on'; };
    show2fa(u.twoFactorEnabled ? 'on' : 'off');
    $('[data-action="2fa-setup"]').addEventListener('click', async () => {
      hide(err2);
      try { const r = await api('/api/account/2fa/setup', {}); $('[data-secret]').textContent = r.secret.match(/.{1,4}/g).join(' '); show2fa('setup'); $('#code').focus(); }
      catch (e) { showError(err2, e); }
    });
    onSubmit($('[data-form="2fa-enable"]'), async d => {
      hide(err2);
      try { await api('/api/account/2fa/enable', { code: d.code.trim() }); location.reload(); } catch (e) { showError(err2, e); }
    });
    onSubmit($('[data-form="2fa-disable"]'), async d => {
      hide(err2);
      try { await api('/api/account/2fa/disable', { password: d.password, code: d.code.trim() }); location.reload(); } catch (e) { showError(err2, e); }
    });

    // Admin
    if (u.role !== 'ADMIN') return;
    const box = $('[data-admin]'); box.hidden = false;
    let list;
    try { list = await api('/api/admin/users'); }
    catch (e) { $('[data-admin-msg]').textContent = e.message; $('.table-wrap', box).hidden = true; return; }
    const tbody = $('[data-users]');
    for (const x of list.users) {
      const tr = document.createElement('tr');
      for (const v of [x.name, x.email, x.emailVerified ? 'Да' : 'Нет', x.twoFactorEnabled ? 'Вкл.' : 'Выкл.']) {
        const td = document.createElement('td'); td.textContent = v; tr.append(td);
      }
      const td = document.createElement('td');
      if (x.id === u.id) td.textContent = ROLE_RU[x.role] || x.role;
      else {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `Роль для ${x.email}`);
        for (const r of ['USER', 'SUPPORT', 'ADMIN']) sel.add(new Option(ROLE_RU[r], r, false, r === x.role));
        sel.addEventListener('change', async () => {
          const prev = x.role;
          try { await api(`/api/admin/users/${encodeURIComponent(x.id)}/role`, { role: sel.value }); x.role = sel.value; say(`${x.email}: роль «${ROLE_RU[sel.value]}».`); }
          catch (e) { sel.value = prev; say(e.message); }
        });
        td.append(sel);
      }
      tr.append(td); tbody.append(tr);
    }
  },
};

pages[document.body.dataset.page]?.();
const nextParam = safeNext(params.get('next'));
if (nextParam) $$('a[href="register.html"], a[href="login.html"]', $('main') || document).forEach(l => l.href += `?next=${encodeURIComponent(nextParam)}`);
if (document.body.dataset.page === 'login' && params.get('reset')) {
  const ok = document.createElement('div'); ok.className = 'alert ok'; ok.textContent = 'Пароль обновлён. Войдите с новым паролем.';
  $('form').before(ok);
}
