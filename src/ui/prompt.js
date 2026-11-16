'use strict';

const api = window.promptView;
const dialog = document.getElementById('prompt');
const accept = document.getElementById('prompt-accept');
const cancel = document.getElementById('prompt-cancel');
const message = document.getElementById('prompt-message');
const detail = document.getElementById('prompt-detail');
function answer(accepted) {
  accept.disabled = cancel.disabled = true;
  void api.answer(accepted).catch(() => {
    accept.disabled = cancel.disabled = false;
  });
}
const dismiss = () => answer(false);

cancel.addEventListener('click', dismiss);
accept.addEventListener('click', () => answer(true));
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  dismiss();
});

void api.details().then(value => {
  document.getElementById('prompt-title').textContent = value.title;
  message.textContent = value.message || '';
  message.hidden = !value.message;
  detail.textContent = value.detail || '';
  detail.hidden = !value.detail;
  cancel.hidden = !value.confirm;
  accept.textContent = value.action;
  if (value.danger) accept.className = 'danger';
  dialog.showModal();
}).catch(dismiss);
