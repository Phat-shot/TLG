import { h, mount, errText } from '../ui';
import { login, guest, authConfig, type User } from '../api';

export async function showLogin(onDone: (u: User) => void) {
  const cfg = await authConfig();
  const guestOk = cfg.guest_login_enabled !== false;
  let tab: 'guest' | 'login' = guestOk ? 'guest' : 'login';
  const err = h('div', { class: 'err' });
  const body = h('div');

  const render = () => {
    err.textContent = '';
    body.replaceChildren(tab === 'guest' ? guestForm() : loginForm());
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  };
  const tabs = h('div', { class: 'tabs' },
    guestOk ? h('button', { 'data-tab': 'guest', onclick: () => { tab = 'guest'; render(); } }, 'Als Gast') : null,
    h('button', { 'data-tab': 'login', onclick: () => { tab = 'login'; render(); } }, 'Craftworks-Account'),
  );
  const busy = async (fn: () => Promise<User>) => {
    err.textContent = '';
    body.querySelectorAll('button').forEach(b => (b.disabled = true));
    try { onDone(await fn()); }
    catch (e: any) { err.textContent = errText(e.code || e.message); body.querySelectorAll('button').forEach(b => (b.disabled = false)); }
  };
  const guestForm = () => {
    const name = h('input', { placeholder: 'Spielername (2–24 Zeichen)', maxlength: 24, autofocus: true });
    const privacy = h('input', { type: 'checkbox' });
    const form = h('form', { onsubmit: (e: Event) => { e.preventDefault(); busy(() => guest(name.value.trim(), privacy.checked)); } },
      h('label', {}, 'Name'), name,
      h('label', { class: 'row', style: { marginTop: '12px' } }, privacy, ' Datenschutzhinweise von Craftworks akzeptiert'),
      h('div', { style: { marginTop: '14px' } }, h('button', { class: 'primary', type: 'submit' }, 'Rein in den Kerker')),
      h('p', { class: 'muted' }, 'Ein Gast-Account wird auf dem Craftworks-Server angelegt. Der Name ist für den Abend reserviert.'),
    );
    return form;
  };
  const loginForm = () => {
    const email = h('input', { type: 'email', placeholder: 'E-Mail', autocomplete: 'username' });
    const pw = h('input', { type: 'password', placeholder: 'Passwort', autocomplete: 'current-password' });
    return h('form', { onsubmit: (e: Event) => { e.preventDefault(); busy(() => login(email.value.trim(), pw.value)); } },
      h('label', {}, 'E-Mail'), email, h('label', {}, 'Passwort'), pw,
      h('div', { style: { marginTop: '14px' } }, h('button', { class: 'primary', type: 'submit' }, 'Anmelden')),
      h('p', { class: 'muted' }, 'Registrieren und E-Mail bestätigen geht direkt in Craftworks.'),
    );
  };
  mount(h('div', { class: 'center' }, h('div', { class: 'card' },
    h('h1', {}, 'Kerker', h('small', {}, 'The LAN Game')),
    h('p', { class: 'muted', style: { marginTop: 0 } }, 'Einer baut den Kerker. Die anderen holen das Artefakt. Dann wird getauscht.'),
    tabs, body, err,
  )));
  render();
}
