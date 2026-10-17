const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');
const { webhook, config, event, runOriginalMessageHandler } = require('./helpers/webhook-controller-harness.cjs');
const failure = (code, field = 'code') =>
  Object.assign(new Error('PRIVATE_PASSWORD_CANARY 5511999990001'), {
    [field]: code,
    meta: {
      payload: 'PRIVATE_MESSAGE_CANARY',
      url: 'https://recipient.invalid/webhook?secret=PRIVATE_URL_SECRET_CANARY',
      personal: 'PRIVATE_PERSON_CANARY@example.invalid',
    },
    cause: new Error('PRIVATE_CAUSE_CANARY'),
    stack: 'PRIVATE_STACK_CANARY',
  });

test('A: first successful read makes exactly one POST scoped to the same instance', async () => {
  const h = webhook({
    readConfig: async (_, query) => {
      assert.equal(query.where.instanceId, 'synthetic-instance-id');
      return config();
    },
  });
  const payload = event();
  await h.controller.emit(payload);
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.delays, []);
  assert.deepEqual(h.calls.order, ['read', 'post']);
  assert.equal(h.calls.posts[0].body.data, payload.data);
});
for (const code of ['P1001', 'P1002', 'P1017', 'P2024']) {
  for (const field of ['code', 'errorCode']) {
    test(`B/C: ${code} in ${field} recovers with one POST`, async () => {
      const h = webhook({
        readConfig: async (n) => {
          if (n === 1) throw failure(code, field);
          return config();
        },
      });
      await h.controller.emit(event());
      assert.equal(h.calls.reads, 2);
      assert.equal(h.calls.posts.length, 1);
      assert.deepEqual(h.calls.delays, [100]);
      assert.deepEqual(h.calls.order, ['read', 'wait:100', 'read', 'post']);
    });
  }
}
test('D: mixed transient failures use 100/200/400 then recover on read four', async () => {
  const codes = ['P1001', 'P1017', 'P1002'];
  const h = webhook({
    readConfig: async (n) => {
      if (n < 4) throw failure(codes[n - 1]);
      return config();
    },
  });
  await h.controller.emit(event());
  assert.equal(h.calls.reads, 4);
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.delays, [100, 200, 400]);
});
for (const code of ['P1001', 'P1002', 'P1017', 'P2024']) {
  test(`E: persistent ${code} stops at four reads, rejects explicitly and never POSTs`, async () => {
    const h = webhook({
      readConfig: async () => {
        throw failure(code);
      },
    });
    await assert.rejects(
      h.controller.emit(event()),
      (error) => error.code === 'WEBHOOK_CONFIG_READ_FAILED' && error.databaseCode === code && error.attempts === 4,
    );
    assert.equal(h.calls.reads, 4);
    assert.equal(h.calls.posts.length, 0);
    assert.deepEqual(h.calls.delays, [100, 200, 400]);
    assert.equal(h.calls.logs.filter((entry) => entry.value.event === 'webhook_config_read_failed').length, 1);
  });
}
for (const code of [
  'P1000',
  'P1003',
  'P1008',
  'P1010',
  'P1011',
  'P1012',
  'P2021',
  'P2022',
  'P2034',
  'P2037',
  'ECONNRESET',
  'P9999',
]) {
  test(`F: ${code} is not blindly retried`, async () => {
    const h = webhook({
      readConfig: async () => {
        throw failure(code);
      },
    });
    await assert.rejects(
      h.controller.emit(event()),
      (error) => error.code === 'WEBHOOK_CONFIG_READ_FAILED' && error.attempts === 1,
    );
    assert.equal(h.calls.reads, 1);
    assert.equal(h.calls.posts.length, 0);
    assert.deepEqual(h.calls.delays, []);
  });
}
test('F: message text mentioning P1001 is not treated as a transient code', async () => {
  const h = webhook({
    readConfig: async () => {
      throw Error('P1001 PRIVATE_PASSWORD_CANARY');
    },
  });
  await assert.rejects(h.controller.emit(event()), (error) => error.databaseCode === 'UNKNOWN' && error.attempts === 1);
  assert.equal(h.calls.reads, 1);
});
test('F: permanent request code takes precedence over initialization errorCode', async () => {
  const h = webhook({
    readConfig: async () => {
      throw Object.assign(failure('P1000'), { errorCode: 'P1001' });
    },
  });
  await assert.rejects(h.controller.emit(event()), (error) => error.databaseCode === 'P1000' && error.attempts === 1);
});
test('G: HTTP retries remain independent: one read, three POSTs, original HTTP backoff', async () => {
  const h = webhook({
    post: async (_, n) => {
      if (n < 3) throw Object.assign(Error('synthetic timeout'), { code: 'ECONNABORTED' });
    },
  });
  await h.controller.emit(event());
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.posts.length, 3);
  assert.deepEqual(h.calls.delays, [1000, 2000]);
  for (const post of h.calls.posts) assert.equal(post.body.data.key.id, 'stable-synthetic-id');
});
test('G: read retry and HTTP retry keep their own delay policies', async () => {
  const h = webhook({
    readConfig: async (n) => {
      if (n === 1) throw failure('P1017');
      return config();
    },
    post: async (_, n) => {
      if (n === 1) throw Object.assign(Error('synthetic timeout'), { code: 'ECONNABORTED' });
    },
  });
  await h.controller.emit(event());
  assert.equal(h.calls.reads, 2);
  assert.equal(h.calls.posts.length, 2);
  assert.deepEqual(h.calls.delays, [100, 1000]);
});
test('G: non-retryable HTTP status still stops immediately', async () => {
  const h = webhook({
    post: async () => {
      throw Object.assign(Error('synthetic rejected'), { response: { status: 401 } });
    },
  });
  await h.controller.emit(event());
  assert.equal(h.calls.reads, 1);
  assert.equal(h.calls.posts.length, 1);
  assert.deepEqual(h.calls.delays, []);
});
test('H: original messages.upsert persists and invokes chatbot once despite three config retries', async () => {
  const h = webhook({
    readConfig: async (n) => {
      if (n < 4) throw failure('P1001');
      return config();
    },
  });
  const payload = { ...event().data, messageTimestamp: 1792256400 };
  const { effects, outcomes } = await runOriginalMessageHandler(h.controller, payload);
  assert.equal(effects.preparation, 1);
  assert.equal(effects.persistence, 1);
  assert.equal(effects.chatbot, 1);
  assert.equal(effects.emissions, 1);
  assert.equal(effects.errors.length, 0);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(h.calls.reads, 4);
  assert.equal(h.calls.posts.length, 1);
});
test('H: terminal config failure never reexecutes previous side effects', async () => {
  const h = webhook({
    readConfig: async () => {
      throw failure('P1017');
    },
  });
  const { effects, outcomes } = await runOriginalMessageHandler(h.controller, {
    ...event().data,
    messageTimestamp: 1792256400,
  });
  assert.equal(effects.preparation, 1);
  assert.equal(effects.persistence, 1);
  assert.equal(effects.chatbot, 1);
  assert.equal(effects.emissions, 1);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(h.calls.posts.length, 0);
});
for (const [code, levels] of [
  ['P1001', []],
  ['P1017', ['WEBHOOKS']],
  ['PRIVATE_CODE_5511999990001', []],
]) {
  test(`I: config logs and propagated error are sanitized (${code}, logs=${levels.length})`, async () => {
    const h = webhook({
      logLevels: levels,
      readConfig: async () => {
        throw failure(code);
      },
    });
    let caught;
    try {
      await h.controller.emit(event());
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    assert.equal(caught.cause, undefined);
    for (const { value } of h.calls.logs) {
      const keys = ['local', 'event', 'databaseCode', 'attempt'];
      if (value.event === 'webhook_config_read_retry') keys.push('delayMs');
      assert.deepEqual(Object.keys(value).sort(), keys.sort());
    }
    const output = JSON.stringify(h.calls.logs) + inspect(caught);
    for (const secret of [
      'PRIVATE_MESSAGE_CANARY',
      '5511999990001',
      'PRIVATE_SECRET_CANARY',
      'PRIVATE_API_KEY_CANARY',
      'PRIVATE_PASSWORD_CANARY',
      'PRIVATE_CAUSE_CANARY',
      'PRIVATE_STACK_CANARY',
      'PRIVATE_CODE_',
      'PRIVATE_URL_SECRET_CANARY',
      'PRIVATE_PERSON_CANARY',
    ]) {
      assert.ok(!output.includes(secret), 'sensitive canary leaked');
    }
    assert.ok(output.includes('webhook_config_read_failed'));
    assert.equal(h.calls.posts.length, 0);
  });
}
test('I: recovered configuration logs contain no payload, sender, secret or API key', async () => {
  const h = webhook({
    readConfig: async (n) => {
      if (n === 1) throw failure('P1001');
      return config();
    },
  });
  await h.controller.emit(event());
  const output = JSON.stringify(h.calls.logs);
  for (const secret of ['PRIVATE_MESSAGE_CANARY', '5511999990001', 'PRIVATE_SECRET_CANARY', 'PRIVATE_API_KEY_CANARY']) {
    assert.ok(!output.includes(secret));
  }
});
for (const value of [null, { enabled: false }, { ...config(), events: ['CONNECTION_UPDATE'] }]) {
  test('J: absent/disabled/filtered config preserves no-POST behavior', async () => {
    const h = webhook({ readConfig: async () => value });
    await h.controller.emit(event());
    assert.equal(h.calls.reads, 1);
    assert.equal(h.calls.posts.length, 0);
    assert.deepEqual(h.calls.delays, []);
  });
}
test('J: integration filter and absent instance preserve original behavior', async () => {
  const h = webhook();
  await h.controller.emit({ ...event(), integration: ['rabbitmq'] });
  assert.equal(h.calls.reads, 0);
  const absent = webhook({ present: false });
  await absent.controller.emit(event());
  assert.equal(absent.calls.reads, 0);
  assert.equal(absent.calls.posts.length, 0);
});
test('J: direct EventController.get remains unchanged outside webhook emission', async () => {
  const h = webhook({
    readConfig: async () => {
      throw failure('P1001');
    },
  });
  await assert.rejects(h.controller.get('synthetic-fixture'), (error) => error.code === 'P1001');
  assert.equal(h.calls.reads, 1);
  assert.deepEqual(h.calls.delays, []);
});
test('J: global webhook also benefits from config read recovery', async () => {
  const h = webhook({
    globalEnabled: true,
    readConfig: async (n) => {
      if (n === 1) throw failure('P1001');
      return null;
    },
  });
  await h.controller.emit(event());
  assert.equal(h.calls.reads, 2);
  assert.equal(h.calls.posts.length, 1);
  assert.equal(h.calls.posts[0].httpConfig.baseURL, 'https://global.invalid/webhook');
});
