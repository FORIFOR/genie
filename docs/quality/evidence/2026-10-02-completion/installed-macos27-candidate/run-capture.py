from pathlib import Path
import subprocess,json,sys,hashlib,datetime
root=Path('/private/tmp/genie-transactions-20261002/installed-macos27')
root.mkdir(mode=0o700,exist_ok=True)
app=Path('/Applications/Genie.app')
expected='2880bc06f89e4a468d8c9c2981fc2916b87265ee0868cedce86fe1348fa3d74e'
actual=hashlib.sha256((app/'Contents/MacOS/Genie').read_bytes()).hexdigest()
if actual!=expected: raise SystemExit('Installed candidate hash changed; refusing capture')
def instances():
    found=[]
    for name in ['Genie','GenieMac']:
        r=subprocess.run(['/usr/bin/pgrep','-x',name],capture_output=True,text=True)
        if r.returncode not in [0,1]: raise SystemExit('Unable to check existing app processes')
        if r.returncode==0: found.extend(int(x) for x in r.stdout.split())
    return found
if instances(): raise SystemExit('A Genie instance already exists; refusing overlapping capture')
mode=sys.argv[1];folder=root/mode;folder.mkdir(mode=0o700,exist_ok=False)
data=folder/'data';data.mkdir(mode=0o700)
args=sys.argv[2:]
command=['/usr/bin/open','-n','-W','--env',f'ASTRA_DATA_ROOT={data}','--env',f'ASTRA_SELFTEST_EXIT_RECEIPT={folder}/exit.json','--stdout',str(folder/'stdout.log'),'--stderr',str(folder/'stderr.log'),str(app),'--args','-astra.transcription.cloudGoogleSTT','NO','--selftest',*args]
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
result=subprocess.run(command,timeout=180)
output=(folder/'stdout.log').read_text() if (folder/'stdout.log').exists() else ''
print(output)
receipt=json.loads((folder/'exit.json').read_text()) if (folder/'exit.json').exists() else None
remaining=instances()
(folder/'invocation.json').write_text(json.dumps({'startedAt':start,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'command':command,'openExitCode':result.returncode,'receipt':receipt,'binarySHA256':actual,'remainingNamedAppPids':remaining},indent=2)+'\n')
if result.returncode or receipt is None or receipt.get('exitCode')!=0 or remaining or 'SELFTEST_FAIL' in output or 'SELFTEST_SKIP' in output:sys.exit(1)
