#!/usr/bin/env python3
"""Copie toutes les données d'Upstash vers le Redis du VPS (à travers le relais local).

À lancer SUR LE SERVEUR, après install.sh, quand Upstash répond de nouveau (quota) :
    UPSTASH_URL=https://xxx.upstash.io UPSTASH_TOKEN=xxx python3 migrate.py
(les deux valeurs = KV_REST_API_URL et KV_REST_API_TOKEN actuels de Vercel). Rien n'est affiché des secrets.

Copie chaque clé avec son type (texte, hash, liste, set, zset) et sa durée de vie, puis compare le nombre de clés
et un échantillon. Relançable : chaque clé est remplacée à l'identique.
"""
import json
import os
import sys
import urllib.request

SRC_URL = os.environ['UPSTASH_URL'].rstrip('/')
SRC_TOKEN = os.environ['UPSTASH_TOKEN']
DST_URL = os.environ.get('RELAY_URL', 'http://127.0.0.1:7379')
DST_TOKEN = open(os.environ.get('RELAY_TOKEN_FILE', '/etc/rng-relay/token')).read().strip()


def pipeline(url, token, commands):
    req = urllib.request.Request(f'{url}/pipeline', data=json.dumps([[str(a) for a in c] for c in commands]).encode(),
                                 headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as res:
        out = json.load(res)
    for r in out:
        if 'error' in r:
            raise RuntimeError(r['error'])
    return [r['result'] for r in out]


src = lambda cmds: pipeline(SRC_URL, SRC_TOKEN, cmds)
dst = lambda cmds: pipeline(DST_URL, DST_TOKEN, cmds)

# 1. Toutes les clés (SCAN par paquets de 500).
keys, cursor = [], '0'
while True:
    cursor, batch = src([['SCAN', cursor, 'COUNT', 500]])[0]
    keys += batch
    if str(cursor) == '0':
        break
keys = sorted(set(keys))
print(f'{len(keys)} clés à copier')

# 2. Type et durée de vie, puis contenu, par paquets de 100 clés.
copied = 0
for i in range(0, len(keys), 100):
    chunk = keys[i:i + 100]
    meta = src([c for k in chunk for c in (['TYPE', k], ['PTTL', k])])
    reads, kinds = [], []
    for j, k in enumerate(chunk):
        kind = meta[2 * j]
        kinds.append((k, kind, int(meta[2 * j + 1])))
        reads.append({'string': ['GET', k], 'hash': ['HGETALL', k], 'list': ['LRANGE', k, 0, -1], 'set': ['SMEMBERS', k],
                      'zset': ['ZRANGE', k, 0, -1, 'WITHSCORES']}.get(kind, ['TYPE', k]))
    values = src(reads)
    writes = []
    for (k, kind, ttl), v in zip(kinds, values):
        if kind == 'none':
            continue  # expirée entre-temps
        writes.append(['DEL', k])
        if kind == 'string':
            writes.append(['SET', k, v])
        elif kind == 'hash' and v:
            writes.append(['HSET', k, *v])
        elif kind == 'list' and v:
            writes.append(['RPUSH', k, *v])
        elif kind == 'set' and v:
            writes.append(['SADD', k, *v])
        elif kind == 'zset' and v:
            pairs = []
            for m, score in zip(v[0::2], v[1::2]):
                pairs += [score, m]
            writes.append(['ZADD', k, *pairs])
        elif kind not in ('hash', 'list', 'set', 'zset'):
            print(f'  ! type inconnu {kind} pour {k}, ignorée', file=sys.stderr)
            continue
        if ttl > 0:
            writes.append(['PEXPIRE', k, ttl])
        copied += 1
    if writes:
        dst(writes)
    print(f'  {min(i + 100, len(keys))}/{len(keys)}', end='\r', flush=True)

# 3. Contrôle : même nombre de clés et mêmes contenus sur un échantillon.
n_src, n_dst = src([['DBSIZE']])[0], dst([['DBSIZE']])[0]
sample = keys[:: max(1, len(keys) // 50)]
bad = 0
for k in sample:
    kind = src([['TYPE', k]])[0]
    cmd = {'string': ['GET', k], 'hash': ['HGETALL', k], 'list': ['LRANGE', k, 0, -1], 'set': ['SMEMBERS', k],
           'zset': ['ZRANGE', k, 0, -1, 'WITHSCORES']}.get(kind)
    if not cmd:
        continue
    a, b = src([cmd])[0], dst([cmd])[0]
    if (sorted(a) if isinstance(a, list) and kind in ('hash', 'set') else a) != (sorted(b) if isinstance(b, list) and kind in ('hash', 'set') else b):
        bad += 1
        print(f'  ÉCART sur {k}')
print(f'\n{copied} clés copiées · Upstash {n_src} clés / VPS {n_dst} clés · échantillon de {len(sample)} : {bad} écart(s)')
sys.exit(1 if bad else 0)
