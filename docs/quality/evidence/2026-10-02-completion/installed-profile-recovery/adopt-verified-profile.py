from pathlib import Path
import hashlib,json,datetime,shutil,sys,os
repo=Path('/Users/shuhei/Projects/genie');result=Path(sys.argv[1]);reference=repo/'docs/quality/evidence/2026-10-02-completion/installed-macos27-candidate'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
v=json.loads((result/'result.json').read_text());assert v['status']=='PASS' and len(v['records'])==9
expected_labels=['geometry','light','golden-light','dark','golden-dark','shape','occupation','candidate-density','density']
assert [r['label'] for r in v['records']]==expected_labels
assert v['candidateReference']==str(reference)
review=json.loads((repo/'docs/quality/evidence/2026-10-02-completion/installed-macos27-independent-review.json').read_text())
reviewed=review['reviewedEvidenceSha256']|review['viewedImageSha256']
for rel,expected in reviewed.items(): assert sha(repo/rel)==expected,rel
assert v['limits']=={'goldenPercent':0.5,'geometryPt':2,'densityPp':1.5}
assert sha(Path('/Applications/Genie.app/Contents/MacOS/Genie'))==v['binarySHA256']
for check in v['records']:
 assert check['exitCode']==0 and check['binarySHA256']==v['binarySHA256']
 assert check['receipt']=={'schema':1,'exitCode':0,'normalExit':True}
 log=(result/check['label']/'stdout.log').read_text();assert 'SELFTEST_OK' in log and 'SELFTEST_FAIL' not in log and 'SELFTEST_SKIP' not in log
names=['01-voice-hud-idle','02-voice-hud-listening','02b-voice-hud-preparing','03-recording-workspace','04-recording-transcript','05-recording-rag','08-meeting-detail','09-permission-denied','10-agent-timeline','11-meeting-canvas']
assert len(list((reference/'geometry/snapshots').glob('*.json')))==6
for mode in ['light','dark']:
 for name in names:
  path=reference/mode/'images'/(name+'.png');assert sha(path)==reviewed[str(path.relative_to(repo))]
 manifest=json.loads((reference/'manifest.json').read_text())
 layout=json.loads((reference/mode/'images/capture-layout.json').read_text())
 for item in manifest['images']:
  if item['theme']==mode: assert layout[item['name']]==item['layout']
for path in (reference/'geometry/snapshots').glob('*.json'): assert sha(path)==reviewed[str(path.relative_to(repo))]
profile=repo/'docs/golden-screenshots/environments/macos-27.0.1-2x-safe-top-32';assert not profile.exists();stage=profile.parent/'.macos-27-profile-adoption';assert not stage.exists();stage.mkdir()
for mode in ['light','dark']:
 dst=stage/mode;dst.mkdir()
 for name in names:shutil.copy2(reference/mode/'images'/(name+'.png'),dst/(name+'.png'))
 shutil.copy2(reference/mode/'images/capture-layout.json',dst/'capture-layout.json')
shutil.copytree(reference/'geometry/snapshots',stage/'geometry');shutil.copy2(result/'profile-density.json',stage/'density-baseline.json')
provenance={'adoptedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'profile':'macos-27.0.1-2x-safe-top-32','scope':'Environment-specific reference for previously documented UI; product sizes/colors and gate tolerances unchanged. No release-ready claim.','candidateCaptureBinarySHA256':'2880bc06f89e4a468d8c9c2981fc2916b87265ee0868cedce86fe1348fa3d74e','candidateManifestSHA256':sha(reference/'manifest.json'),'independentReview':'docs/quality/evidence/2026-10-02-completion/installed-macos27-independent-review.json','independentReviewSHA256':sha(repo/'docs/quality/evidence/2026-10-02-completion/installed-macos27-independent-review.json'),'freshValidationBinarySHA256':v['binarySHA256'],'freshValidationManifestSHA256':sha(result/'result.json'),'limits':v['limits'],'changesExplained':'Prior approved safe-top HUD dimensions; existing source action hit area and task text layout; meeting detail sidebar/native chrome difference not attributed solely to OS. See macos-27-profile/ROUND.md.','files':{str(p.relative_to(stage)):sha(p) for p in sorted(stage.rglob('*')) if p.is_file()}}
(stage/'provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2)+'\n');os.rename(stage,profile);print(profile)
