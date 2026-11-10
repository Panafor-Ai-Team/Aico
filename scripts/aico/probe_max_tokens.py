#!/usr/bin/env python3
"""Measure which CheapVibeCode models ignore `max_tokens`.

The usage ledger holds `max_tokens` worth of output only for models listed in
AICO_LEDGER_CAPPED_OUTPUT_MODELS; any other model is held at its own output
ceiling. A model that ignores the cap (usually because reasoning is not counted
against it) must never be listed, or it can cost more than its hold. Rerun this
after CVC adds models, and list only the models it prints as capped.

Sends one `max_tokens: 64` request per chat model in CVC's /v1/models. The
cost is a few cents in total. Standard library only, so it runs on the prod
host, which has python3 but no node.

The key is read from the environment or from --env-file and is never printed.

  python3 scripts/aico/probe_max_tokens.py --env-file /home/panachat/panachat/.env
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

CAP = 64
KEY_VAR = 'CHEAPVIBECODE_API_KEY'
NON_CHAT_HINTS = ('embed', 'image', 'video', 'tts', 'whisper', 'asr', 'rerank')


def read_env_file(path, name):
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            key, sep, value = line.strip().partition('=')
            if sep and key == name:
                return value.strip().strip('"').strip("'")
    return None


def request(base, key, path, body=None, timeout=90):
    req = urllib.request.Request(
        base.rstrip('/') + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
        method='GET' if body is None else 'POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def is_chat(model):
    model_id = model.get('id', '').lower()
    if any(hint in model_id for hint in NON_CHAT_HINTS):
        return False
    modalities = model.get('output_modalities')
    return not modalities or 'text' in modalities


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--env-file', help='read the key from this file instead of the environment')
    parser.add_argument('--base-url', default=None)
    parser.add_argument('--model', action='append', help='probe only these ids (repeatable)')
    args = parser.parse_args()

    key = os.environ.get(KEY_VAR) or (args.env_file and read_env_file(args.env_file, KEY_VAR))
    if not key:
        sys.exit(f'{KEY_VAR} is not set')
    base = (
        args.base_url
        or os.environ.get('CHEAPVIBECODE_BASE_URL')
        or (args.env_file and read_env_file(args.env_file, 'CHEAPVIBECODE_BASE_URL'))
        or 'https://cheapvibecode.ru'
    )

    if args.model:
        ids = args.model
    else:
        listed = request(base, key, '/v1/models')
        ids = sorted(m['id'] for m in listed.get('data', listed) if is_chat(m))

    capped = []
    print(f'{"model":<32} {"completion":>10}  finish')
    for model_id in ids:
        body = {
            'max_tokens': CAP,
            'messages': [{'content': 'Write a 500-word essay about rivers.', 'role': 'user'}],
            'model': model_id,
        }
        try:
            data = request(base, key, '/v1/chat/completions', body)
        except urllib.error.HTTPError as error:
            print(f'{model_id:<32} {"-":>10}  HTTP {error.code}')
            continue
        except (urllib.error.URLError, TimeoutError) as error:
            print(f'{model_id:<32} {"-":>10}  {type(error).__name__}')
            continue

        completion = (data.get('usage') or {}).get('completion_tokens')
        finish = ((data.get('choices') or [{}])[0]).get('finish_reason')
        flag = '  <- ignores max_tokens'
        if isinstance(completion, int) and completion <= CAP:
            capped.append(model_id)
            flag = ''
        print(f'{model_id:<32} {str(completion):>10}  {finish}{flag}')

    print()
    # Models that errored are left out: unmeasured means held at the ceiling.
    print('AICO_LEDGER_CAPPED_OUTPUT_MODELS=' + ','.join(capped))


if __name__ == '__main__':
    main()
