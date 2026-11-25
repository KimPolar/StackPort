async function chooseDatabase(page, engine) {
  const explorer = page.getByRole('complementary', { name: '작업 공간 탐색기', exact: true });
  await explorer.getByRole('button', { name: '데이터베이스 연결 추가', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '데이터베이스 연결 추가', exact: true });
  await picker.getByRole('button', { name: engine, exact: true }).click();
}

module.exports = { chooseDatabase };
