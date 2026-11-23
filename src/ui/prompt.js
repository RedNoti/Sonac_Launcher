'use strict';

const api = window.promptView;
const dialog = document.getElementById('prompt');
const accept = document.getElementById('prompt-accept');
const cancel = document.getElementById('prompt-cancel');
const message = document.getElementById('prompt-message');
const detail = document.getElementById('prompt-detail');
function answer(accepted) {
  for (const button of dialog.querySelectorAll('button')) button.disabled = true;
  void api.answer(accepted).catch(() => {
    for (const button of dialog.querySelectorAll('button')) button.disabled = false;
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
  if (value.choices) {
    const actions = document.getElementById('prompt-actions');
    actions.classList.add('prompt-choices');
    document.getElementById('prompt-remember').hidden = !value.rememberChoice;
    actions.replaceChildren(...value.choices.map(choice => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice.label;
      button.className = choice.style || '';
      button.addEventListener('click', () => answer(value.rememberChoice
        ? { value: choice.value, applyToRemaining: document.getElementById('prompt-remember-input').checked }
        : choice.value));
      return button;
    }));
  }
  cancel.hidden = !value.confirm;
  accept.textContent = value.action;
  if (value.danger) accept.className = 'danger';
  dialog.showModal();
  if (value.choices) dialog.querySelector('.prompt-choices button:last-child').focus();
}).catch(dismiss);
