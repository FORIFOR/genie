"""Exercise the actual checker in disposable repos, never change source fixture files."""
from pathlib import Path
import subprocess,tempfile,shutil
checker=Path('scripts/lint-terms.sh').resolve()
cases=[('release-only','Text("リリースノートを書く")',0),('meeting-note','Text("ノートを開く")',1),('same-literal','Text("リリースノートとノート")',1),('same-line-other-literal','Text("リリースノート"); Text("ノート")',1),('other-banned-word','Text("リリースノートと決定事項")',1)]
for name,fixture,expected in cases:
 with tempfile.TemporaryDirectory(prefix='genie-terms-fixture-') as root:
  root=Path(root);(root/'scripts').mkdir();src=root/'apps/genie-macos/Sources/GenieMac';src.mkdir(parents=True)
  shutil.copy(checker,root/'scripts/lint-terms.sh');(src/'Fixture.swift').write_text(fixture+'\n')
  result=subprocess.run(['bash',str(root/'scripts/lint-terms.sh')],capture_output=True,text=True)
  print(f'{name}: expected={expected} actual={result.returncode}\n{result.stdout}')
  assert result.returncode==expected
print('PASS: exact compound accepted; standalone and same-line forbidden terms rejected')
