'use strict';

// Submission is not delivery: native notification failures arrive asynchronously.
function showPluginNotification(Notification, options) {
  if (!Notification.isSupported()) return Promise.reject(new Error('System notifications are not supported on this device'));
  return new Promise((resolve, reject) => {
    const notification = new Notification(options);
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      notification.removeListener('show', shown);
      notification.removeListener('failed', failed);
      if (error) reject(error); else resolve(true);
    };
    const shown = () => finish();
    const failed = (_event, error) => finish(new Error(`System notification failed: ${error || 'the operating system rejected the notification'}`));
    notification.once('show', shown);
    notification.once('failed', failed);
    timer = setTimeout(() => finish(new Error('System notification display was not confirmed; check notification permissions and Focus settings')), 5000);
    timer.unref?.();
    try { notification.show(); } catch (error) { finish(error); }
  });
}
module.exports = { showPluginNotification };
