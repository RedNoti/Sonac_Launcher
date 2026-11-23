'use strict';

// Only explicitly classified file operations may use the local opt-out.
// Security confirmations set requiredConfirmation and always ask again.
async function confirmOperation(details, { skipFileConfirmations, ask, remember }) {
  const optional = details.fileOperation === true && details.requiredConfirmation !== true;
  if (optional && skipFileConfirmations === true) return true;
  const result = await ask({ ...details, allowSkipFileConfirmation: optional });
  const accepted = result === true || result?.accepted === true;
  if (accepted && optional && result?.skipNext === true) await remember();
  return accepted;
}

// Legacy shared/boolean flags are not proof of an explicit extraction choice.
function skipExtractionConfirmation(settings) {
  return settings?.extractPromptPreference?.version === 1 && settings.extractPromptPreference.skip === true;
}

module.exports = { confirmOperation, skipExtractionConfirmation };
