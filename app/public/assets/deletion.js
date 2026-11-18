// Status page for Meta data-deletion requests (linked from the confirmation Meta shows the person).
(async () => {
  const code = params.get('code'), msg = $('[data-msg]'), box = $('[data-code]');
  if (!code || !/^[A-F0-9]{16}$/.test(code)) { msg.textContent = 'В ссылке нет действительного кода подтверждения.'; return; }
  box.textContent = `Код подтверждения: ${code}`; box.hidden = false;
  try {
    const r = await api(`/api/deletion/${code}`);
    msg.textContent = `Готово. Диалоги и подключение, связанные с вашим аккаунтом Instagram, удалены из NeuralDesk ${fmtDate(r.requestedAt)}.`;
  } catch { msg.textContent = "Мы не нашли этот запрос. Если считаете, что это ошибка, напишите в поддержку и укажите код ниже."; }
})();
