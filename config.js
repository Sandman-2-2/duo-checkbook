/*
 * Duo Checkbook configuration.
 * Paste your Apps Script web app address (ends in /exec) below.
 * This address is not a secret: every request still needs a paired device key.
 * "test" is optional: a separate TEST Sheet + deployment for trying changes safely.
 */
window.DUO_CONFIG = {
  appVersion: '2.0.0',
  endpoints: {
    live: '',
    test: ''
  },
  // Width (in CSS pixels) at which the two-panel "unfolded" layout turns on.
  // Check Settings → Screen on your Duo (folded and unfolded) and adjust if needed.
  widePanelMinWidth: 760
};
