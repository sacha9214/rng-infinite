#!/usr/bin/env python3
"""Relais HTTP compatible avec l'API REST d'Upstash, devant un Redis local.

Le site (api/_lib.js) envoie `POST /pipeline` avec `Authorization: Bearer <jeton>` et un corps JSON
`[["CMD", "arg", ...], ...]` ; il attend en retour `[{"result": ...} | {"error": "..."}, ...]`, comme Upstash.
Ce relais fait exactement ça, sans aucune dépendance (Python standard + protocole RESP écrit à la main).

Écoute seulement sur 127.0.0.1 : Caddy le publie en HTTPS. Le jeton est lu dans RELAY_TOKEN_FILE.
"""
import hmac
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = ('127.0.0.1', int(os.environ.get('RELAY_PORT', '7379')))
REDIS = (os.environ.get('REDIS_HOST', '127.0.0.1'), int(os.environ.get('REDIS_PORT', '6379')))
TOKEN = open(os.environ.get('RELAY_TOKEN_FILE', '/etc/rng-relay/token')).read().strip().encode()
MAX_BODY = 2 * 1024 * 1024
# Commandes d'administration refusées : le site n'en a jamais besoin, un jeton volé ne doit pas pouvoir tout casser.
DENY = {'FLUSHALL', 'FLUSHDB', 'CONFIG', 'SHUTDOWN', 'DEBUG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'REPLICAOF', 'SLAVEOF',
        'MODULE', 'ACL', 'MIGRATE', 'SCRIPT', 'EVAL', 'EVALSHA', 'FUNCTION', 'FCALL', 'MONITOR', 'SYNC', 'PSYNC', 'CLIENT'}


class Redis:
    """Une connexion RESP par thread (le serveur HTTP traite chaque requête dans son propre thread)."""
    local = threading.local()

    @classmethod
    def conn(cls):
        c = getattr(cls.local, 'c', None)
        if c is None:
            c = cls.local.c = Redis()
        return c

    def __init__(self):
        self.sock = socket.create_connection(REDIS, timeout=10)
        self.buf = self.sock.makefile('rb')

    def pipeline(self, commands):
        out = bytearray()
        for cmd in commands:
            out += b'*%d\r\n' % len(cmd)
            for arg in cmd:
                data = arg.encode()
                out += b'$%d\r\n%s\r\n' % (len(data), data)
        self.sock.sendall(out)
        return [self.read() for _ in commands]

    def read(self):
        line = self.buf.readline()
        if not line:
            raise ConnectionError('Redis closed the connection')
        kind, rest = line[:1], line[1:-2]
        if kind == b'+':
            return {'result': rest.decode()}
        if kind == b'-':
            return {'error': rest.decode()}
        if kind == b':':
            return {'result': int(rest)}
        if kind == b'$':
            return {'result': self.bulk(int(rest))}
        if kind == b'*':
            n = int(rest)
            return {'result': None if n < 0 else [self.item() for _ in range(n)]}
        raise ValueError(f'Unexpected RESP reply {line!r}')

    def bulk(self, n):
        if n < 0:
            return None
        data = self.buf.read(n + 2)[:-2]
        return data.decode('utf-8', 'replace')

    def item(self):
        r = self.read()
        if 'error' in r:
            return r['error']
        return r['result']


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # pas de journal par requête (le sondage des duels est fréquent)
        pass

    def reply(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True})
        self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        if self.path != '/pipeline':
            return self.reply(404, {'error': 'Not found'})
        auth = self.headers.get('Authorization', '').encode()
        if not hmac.compare_digest(auth, b'Bearer ' + TOKEN):
            return self.reply(401, {'error': 'Unauthorized'})
        size = int(self.headers.get('Content-Length') or 0)
        if size <= 0 or size > MAX_BODY:
            return self.reply(413, {'error': 'Body too large'})
        try:
            commands = json.loads(self.rfile.read(size))
            assert isinstance(commands, list) and all(isinstance(c, list) and c and all(isinstance(a, str) for a in c) for c in commands)
        except (ValueError, AssertionError):
            return self.reply(400, {'error': 'Expected [["CMD", "arg", ...], ...]'})
        if any(c[0].upper() in DENY for c in commands):
            return self.reply(403, {'error': 'Command not allowed'})
        try:
            results = Redis.conn().pipeline(commands)
        except (OSError, ConnectionError, ValueError):
            Redis.local.c = None  # connexion cassée : on en rouvre une au prochain appel
            try:
                results = Redis.conn().pipeline(commands)
            except Exception as err:  # Redis indisponible
                Redis.local.c = None
                return self.reply(502, {'error': f'Redis unavailable: {err}'})
        self.reply(200, results)


if __name__ == '__main__':
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.request_queue_size = 128
    print(f'Relais Redis sur http://{LISTEN[0]}:{LISTEN[1]} → Redis {REDIS[0]}:{REDIS[1]}', flush=True)
    ThreadingHTTPServer(LISTEN, Handler).serve_forever()
