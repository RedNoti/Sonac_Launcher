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
dialog.addEventListener('click', event => {
  if (!dialog.classList.contains('restart-prompt') || event.target !== dialog) return;
  const { left, right, top, bottom } = dialog.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dismiss();
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
  if (value.restart) {
    dialog.classList.add('restart-prompt');
    const mark = document.createElement('span');
    mark.className = 'update-mark';
    mark.append(icon('check'));
    dialog.prepend(mark);
    accept.prepend(icon('sync'));
  }
  dialog.showModal();
}).catch(dismiss);
