from pathlib import Path
import json
import os
import re
import secrets
import shutil

env = Path('/etc/orbit-ai/server.env')
text = env.read_text()
match = re.search(r'^PRINT_BRIDGE_TOKEN="?([a-f0-9]{64})"?$', text, re.M)
token = match.group(1) if match else secrets.token_hex(32)
updates = {
    'PRINT_ENABLED': '1', 'PRINT_BRIDGE_TOKEN': token,
    'PRINT_QUEUE_FILE': '/var/lib/orbit-ai/print-queue.json',
    'ANYSEARCH_SKILL_DIR': '/opt/orbit-ai/anysearch-skill',
}
for key, value in updates.items():
    text = re.sub(r'^' + key + r'=.*\n?', '', text, flags=re.M)
    text = text.rstrip('\n') + '\n' + key + '="' + value + '"\n'
temporary = env.with_suffix('.next')
temporary.write_text(text)
os.chmod(temporary, 0o640)
shutil.chown(temporary, user='root', group='orbit-ai')
os.replace(temporary, env)
agent = Path('/etc/orbit-ai/print-agent.json')
agent.write_text(json.dumps({'sshTarget': 'root@47.100.201.122', 'localPort': 18768, 'token': token}) + '\n')
os.chmod(agent, 0o600)
