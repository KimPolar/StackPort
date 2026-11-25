async function saveDefaultSet(form, name) {
  const sets = form.getByRole('group', { name: '매개변수 세트', exact: true });
  await sets.getByText('세트 저장', { exact: true }).click();
  await sets.getByLabel('세트 이름', { exact: true }).fill(name);
  await sets.getByRole('checkbox', { name: '기본 세트', exact: true }).check();
  await sets.getByRole('button', { name: '새 세트로 저장', exact: true }).click();
  await sets.getByText('매개변수 세트를 저장했습니다.', { exact: true }).waitFor();
  return sets;
}

module.exports = { saveDefaultSet };
