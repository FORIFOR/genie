import datetime, hashlib, json, os, pathlib, plistlib, shutil, subprocess

root = pathlib.Path('/Users/shuhei/Projects/astra').resolve()
canonical = root / 'apps/genie-macos/.build/Genie.app'
installed = pathlib.Path('/Applications/Genie.app')
stage = pathlib.Path('/private/tmp/genie-transactions-20261002/user-app-gate-stage')
candidate = stage / 'Genie.app'
expected_installed = 'a01378c92ef466086c4e6e0c1f8263e66a9da61ec24d026c86ef6cda0f678801'

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def info(app):
    with (app / 'Contents/Info.plist').open('rb') as f: return plistlib.load(f)
def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode: raise RuntimeError('Command failed: ' + args[0] + '\n' + result.stdout)
    return result.stdout
def signature(app):
    text = command(['/usr/bin/codesign','-d','-r','-','--verbose=2',str(app)])
    return [line for line in text.splitlines() if line.startswith(('Identifier=','Authority=','TeamIdentifier=','designated =>'))]
def inventory(path):
    result = {}
    for p in sorted(path.rglob('*')):
        if p.is_symlink(): result[str(p.relative_to(path))] = {'link':os.readlink(p)}
        elif p.is_file(): result[str(p.relative_to(path))] = {'sha256':sha(p),'size':p.stat().st_size}
    return result

old = info(installed)
assert old['CFBundleIdentifier'] == 'com.astra.mac' and old['CFBundleExecutable'] == 'Genie' and old['LSUIElement'] is True
assert sha(installed/'Contents/MacOS/Genie') == expected_installed
old_signature = signature(installed)
signer = next(line.removeprefix('Authority=') for line in old_signature if line.startswith('Authority=Apple Development:'))
stage.mkdir(mode=0o700, exist_ok=False)
command(['/usr/bin/ditto',str(canonical),str(candidate)])
canonical_info = info(canonical)
candidate_info = dict(canonical_info)
candidate_info.update(CFBundleIdentifier=old['CFBundleIdentifier'], CFBundleExecutable=old['CFBundleExecutable'], LSUIElement=old['LSUIElement'])
with (candidate/'Contents/Info.plist').open('wb') as f: plistlib.dump(candidate_info,f,fmt=plistlib.FMT_XML,sort_keys=False)
(candidate/'Contents/MacOS'/canonical_info['CFBundleExecutable']).rename(candidate/'Contents/MacOS'/old['CFBundleExecutable'])
signed = command(['/usr/bin/codesign','--force','--sign',signer,'--identifier','com.astra.mac',str(candidate)])
verified = command(['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',str(candidate)])
(stage/'sign.log').write_text(signed+verified)
candidate_signature = signature(candidate)
requirement = lambda lines: next(line for line in lines if line.startswith('designated =>'))
assert requirement(candidate_signature) == requirement(old_signature)
comparison = {}
for folder in ['Contents/Resources','Contents/Frameworks']:
    before, after = inventory(canonical/folder),inventory(candidate/folder)
    assert before == after
    comparison[folder] = {'identical':True,'canonicalEntries':len(before),'candidateEntries':len(after)}
    (stage/(pathlib.Path(folder).name.lower()+'-inventory.json')).write_text(json.dumps(after,indent=2)+'\n')
before,after=inventory(canonical),inventory(candidate)
changed=[name for name in sorted(set(before)|set(after)) if before.get(name)!=after.get(name)]
assert set(changed) <= {'Contents/Info.plist','Contents/MacOS/Genie','Contents/MacOS/GenieMac','Contents/_CodeSignature/CodeResources'}
compare=stage/'unsigned-comparison';compare.mkdir(mode=0o700)
hashes={}
for name,app in [('canonical',canonical),('candidate',candidate)]:
    exe=app/'Contents/MacOS'/info(app)['CFBundleExecutable']; copy=compare/name
    shutil.copy2(exe,copy)
    command(['/usr/bin/codesign','--remove-signature',str(copy)])
    hashes[name]=sha(copy)
    copy.chmod(0o600)
assert hashes['canonical']==hashes['candidate']
assert sha(installed/'Contents/MacOS/Genie')==expected_installed
manifest={'recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'scope':'Private stage only. Canonical release rebuilt; installed app, Keychain, runtime configuration and permissions untouched. No candidate launch.',
 'apps':{},'infoDifferencesFromCanonical':{key:{'canonical':canonical_info.get(key),'candidate':candidate_info.get(key)} for key in set(canonical_info)|set(candidate_info) if canonical_info.get(key)!=candidate_info.get(key)},
 'resourceComparisons':comparison,'wholeBundleChangedPaths':changed,
 'unsignedExecutableSha256':hashes,'designatedRequirementMatchesInstalled':True,
 'strictSignatureVerified':True,'installedAppUnmodified':True,
 'sourceManifestSha256':sha(root/'docs/quality/evidence/2026-10-02-completion/gate-fixture-fixes/manifest.json'),
 'packageLogSha256':sha(pathlib.Path('/private/tmp/genie-transactions-20261002/gate-fixture-fixes-package-round2.log'))}
for name,app in [('installed',installed),('canonical',canonical),('candidate',candidate)]:
    current=info(app)
    manifest['apps'][name]={'path':str(app),'info':{key:current.get(key) for key in ['CFBundleIdentifier','CFBundleExecutable','CFBundleShortVersionString','CFBundleVersion','LSUIElement']},'executableSha256':sha(app/'Contents/MacOS'/current['CFBundleExecutable']),'signatureMetadata':signature(app)}
(stage/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'stage':str(candidate),'sha256':manifest['apps']['candidate']['executableSha256'],'signatureVerified':True,'installedAppUnmodified':True}))
