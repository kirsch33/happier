import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

import { buildComposeYaml } from './happy_server_infra.mjs';

const sampleArgs = {
  infraDir: '/tmp/stack-infra',
  pgPort: 5432,
  pgUser: 'happy',
  pgPassword: 'pgpw',
  pgDb: 'happy',
  redisPort: 6379,
  minioPort: 9000,
  minioConsolePort: 9001,
  s3AccessKey: 'ACCESSKEY',
  s3SecretKey: 'SECRETKEY',
  s3Bucket: 'happy-bucket',
};

test('minio-init command is a single-element list so `sh -lc` receives the whole script as one arg', () => {
  const doc = parse(buildComposeYaml(sampleArgs));
  const cmd = doc.services['minio-init'].command;

  // Regression guard for the word-split bug: a plain string command is split by
  // compose into separate args, so `sh -lc` would only get `mc` -> usage + exit.
  assert.ok(Array.isArray(cmd), 'minio-init command must be a list, not a folded string');
  assert.equal(cmd.length, 1, 'the whole init script must be one argument to sh -lc');
  assert.match(
    cmd[0],
    /mc alias set .*&&.*mc mb .*&&.*mc anonymous set /s,
    'the single argument must carry the full init script',
  );
});
