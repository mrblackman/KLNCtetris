import os
import sys
import re
import paramiko

def load_credentials():
    """
    Yerel credentials.md dosyasından veya ortam değişkenlerinden (Environment Variables)
    sunucu bağlantı bilgilerini okur.
    """
    creds = {
        'hostname': os.environ.get('SSH_HOST', ''),
        'username': os.environ.get('SSH_USER', ''),
        'password': os.environ.get('SSH_PASS', ''),
        'port': int(os.environ.get('SSH_PORT', 22)),
        'remote_path': os.environ.get('REMOTE_PATH', '/var/www/vhosts/tavlahane.com/tetris23.tavlahane.com')
    }

    # credentials.md varsa bilgileri oradan tamamla
    cred_path = os.path.join(os.path.dirname(__file__), 'credentials.md')
    if os.path.exists(cred_path):
        with open(cred_path, 'r', encoding='utf-8') as f:
            content = f.read()

        host_match = re.search(r'SSH IP:\s*\[?([^\s\]]+)\]?', content)
        user_match = re.search(r'SSH Kullanıcı:\s*\[?([^\s\]]+)\]?', content)
        pass_match = re.search(r'SSH Şifre:\s*\[?([^\s\]]+)\]?', content)
        port_match = re.search(r'SSH Port:\s*\[?([^\s\]]+)\]?', content)
        remote_match = re.search(r'Uzak Dizin:\s*\[?([^\s\]]+)\]?', content)

        if host_match and not creds['hostname']: creds['hostname'] = host_match.group(1).strip()
        if user_match and not creds['username']: creds['username'] = user_match.group(1).strip()
        if pass_match and not creds['password']: creds['password'] = pass_match.group(1).strip()
        if port_match and creds['port'] == 22:
            try: creds['port'] = int(port_match.group(1).strip())
            except ValueError: pass
        if remote_match: creds['remote_path'] = remote_match.group(1).strip()

    return creds

def create_ssh_client(creds):
    if not creds['hostname'] or not creds['username'] or not creds['password']:
        raise ValueError("SSH bağlantı bilgileri (hostname, username, password) bulunamadı! credentials.md dosyasını kontrol edin.")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(creds['hostname'], port=creds['port'], username=creds['username'], password=creds['password'])
    return client

def deploy():
    print("--- Dağıtım (Deployment) Başlatıldı ---")
    creds = load_credentials()
    remote_path = creds['remote_path']
    ssh = create_ssh_client(creds)
    
    # SFTP dosya transferi
    print(f"Uzak dizin kontrol ediliyor: {remote_path}")
    ssh.exec_command(f"mkdir -p {remote_path}")
    
    sftp = ssh.open_sftp()
    
    files_to_upload = [
        'package.json',
        'package-lock.json',
        'ecosystem.config.js',
        'app.js',
        'rules.md'
    ]
    
    dirs_to_upload = [
        'server',
        'client'
    ]

    # Tekil dosyaları yükle
    for file in files_to_upload:
        if os.path.exists(file):
            print(f"Yükleniyor: {file}...")
            sftp.put(file, f"{remote_path}/{file}")

    # Klasörleri özyinelemeli (recursive) yükle
    for folder in dirs_to_upload:
        print(f"Klasör yükleniyor: {folder}...")
        for root, dirs, files in os.walk(folder):
            rel_path = os.path.relpath(root, '.')
            remote_dir = f"{remote_path}/{rel_path.replace(os.sep, '/')}"
            try:
                sftp.mkdir(remote_dir)
            except IOError:
                pass # Dizin zaten var
            
            for file in files:
                local_file = os.path.join(root, file)
                remote_file = f"{remote_dir}/{file}"
                sftp.put(local_file, remote_file)

    sftp.close()

    # Sunucu tarafında çalıştırılacak komutlar
    commands = [
        f"cd {remote_path} && npm install --production",
        f"cd {remote_path} && pm2 startOrRestart ecosystem.config.js --env production"
    ]

    for cmd in commands:
        print(f"Komut çalıştırılıyor: {cmd}")
        stdin, stdout, stderr = ssh.exec_command(cmd)
        
        out = stdout.read().decode('utf-8', errors='replace')
        err = stderr.read().decode('utf-8', errors='replace')
        
        if out: sys.stdout.buffer.write(out.encode('utf-8'))
        if err: 
            sys.stdout.buffer.write(b"\n--- Hata ---\n")
            sys.stdout.buffer.write(err.encode('utf-8'))
            sys.stdout.buffer.write(b"\n")
        sys.stdout.flush()

    ssh.close()
    print("\n--- Dağıtım Başarıyla Tamamlandı ---")

if __name__ == "__main__":
    deploy()
