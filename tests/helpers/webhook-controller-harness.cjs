const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const options = ts.convertCompilerOptionsFromJson(JSON.parse(read('tsconfig.json')).compilerOptions, root).options;

function compile(source, mocks = {}, globals = {}) {
  const module = { exports: {} };
  const result = ts.transpileModule(source, {
    compilerOptions: options,
    reportDiagnostics: true,
    fileName: path.join(root, 'tests/harness-input.ts'),
  });
  const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length)
    throw Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (name) => name,
        getNewLine: () => '\n',
      }),
    );
  vm.runInNewContext(result.outputText, {
    module,
    exports: module.exports,
    require(name) {
      if (name in mocks) return mocks[name];
      throw Error('Unmocked dependency: ' + name);
    },
    console: { log() {}, error() {} },
    Buffer,
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return module.exports;
}

const { EventController } = compile(read('src/api/integrations/event/event.controller.ts'));
const config = () => ({
  enabled: true,
  events: ['MESSAGES_UPSERT'],
  url: 'https://recipient.invalid/webhook',
  headers: { 'x-webhook-secret': 'PRIVATE_SECRET_CANARY' },
});
const event = () => ({
  instanceName: 'synthetic-fixture',
  origin: 'SyntheticSource',
  event: 'messages.upsert',
  data: {
    key: { id: 'stable-synthetic-id', fromMe: false, remoteJid: '5511999990001@s.whatsapp.net' },
    message: { conversation: 'PRIVATE_MESSAGE_CANARY' },
  },
  sender: '5511999990001',
  apiKey: 'PRIVATE_API_KEY_CANARY',
  serverUrl: 'https://provider.invalid',
  dateTime: '2026-10-17T18:00:00Z',
  local: true,
});

function webhook({
  readConfig = async () => config(),
  post = async () => ({}),
  httpAttempts = 3,
  logLevels = [],
  globalEnabled = false,
  present = true,
} = {}) {
  const calls = { reads: 0, posts: [], delays: [], logs: [], order: [] };
  class Logger {
    log(value) {
      calls.logs.push({ level: 'log', value });
    }
    warn(value) {
      calls.logs.push({ level: 'warn', value });
    }
    error(value) {
      calls.logs.push({ level: 'error', value });
    }
  }
  const settings = {
    GLOBAL: { ENABLED: globalEnabled, URL: 'https://global.invalid/webhook' },
    EVENTS: { MESSAGES_UPSERT: true },
    REQUEST: { TIMEOUT_MS: 1000 },
    RETRY: {
      MAX_ATTEMPTS: httpAttempts,
      INITIAL_DELAY_SECONDS: 1,
      USE_EXPONENTIAL_BACKOFF: true,
      MAX_DELAY_SECONDS: 4,
      JITTER_FACTOR: 0,
    },
  };
  const { WebhookController } = compile(
    read('src/api/integrations/event/webhook/webhook.controller.ts'),
    {
      '../event.controller': { EventController },
      '@config/env.config': { configService: { get: (name) => (name === 'LOG' ? { LEVEL: logLevels } : settings) } },
      '@config/logger.config': { Logger },
      axios: {
        create: (httpConfig) => ({
          post: async (_, body) => {
            calls.order.push('post');
            calls.posts.push({ body, httpConfig });
            return post(body, calls.posts.length);
          },
        }),
      },
      jsonwebtoken: { sign: () => 'synthetic-jwt' },
    },
    {
      setTimeout(fn, delay) {
        calls.delays.push(delay);
        calls.order.push('wait:' + delay);
        queueMicrotask(fn);
        return 0;
      },
    },
  );
  const prisma = {
    webhook: {
      findUnique: async (query) => {
        calls.reads++;
        calls.order.push('read');
        return readConfig(calls.reads, query);
      },
    },
  };
  const monitor = { waInstances: present ? { 'synthetic-fixture': { instanceId: 'synthetic-instance-id' } } : {} };
  return { controller: new WebhookController(prisma, monitor), calls };
}

async function runOriginalMessageHandler(controller, payload) {
  // Extract the actual upstream handler without loading an SDK/server/Prisma.
  const source = read('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');
  const ast = ts.createSourceFile('baileys.ts', source, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'BaileysStartupService');
  const member = cls.members.find((node) => node.name?.getText(ast) === 'messageHandle');
  const Effects = compile(
    `class Effects { messageHandle = ${member.initializer.getText(ast)}; } module.exports = Effects;`,
    {},
    {
      Events: new Proxy({}, { get: (_, key) => key }),
      Long: { isLong: () => false },
      status: { 3: 'DELIVERED' },
      sendTelemetry() {},
      saveOnWhatsappCache: async () => {},
      chatbotController: {
        emit: async () => {
          effects.chatbot++;
        },
      },
    },
  );
  const effects = { preparation: 0, persistence: 0, chatbot: 0, emissions: 0, otherEmissions: 0, errors: [] };
  const pending = [];
  const instance = new Effects();
  Object.assign(instance, {
    instance: { name: 'synthetic-fixture', id: 'synthetic-instance-id' },
    instanceId: 'synthetic-instance-id',
    localSettings: { readMessages: false, readStatus: false },
    localChatwoot: { enabled: false },
    localWebhook: { enabled: false },
    configService: { get: (name) => (name === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: true } } : { ENABLED: false }) },
    logger: { log() {}, info() {}, warn() {}, verbose() {}, error: (error) => effects.errors.push(error) },
    prismaRepository: {
      chat: { findFirst: async () => null },
      contact: { findFirst: async () => null },
      message: {
        create: async ({ data }) => {
          effects.persistence++;
          return { ...data, status: 'PENDING' };
        },
      },
    },
    prepareMessage: (received) => {
      effects.preparation++;
      return {
        ...received,
        key: { ...received.key },
        message: { ...received.message },
        messageType: 'conversation',
        status: 'PENDING',
      };
    },
    baileysCache: { get: async () => null, set: async () => {} },
    profilePicture: async () => ({}),
    sendDataWebhook: (kind, data) => {
      if (kind !== 'MESSAGES_UPSERT') {
        effects.otherEmissions++;
        return;
      }
      effects.emissions++;
      const work = controller.emit({ ...event(), event: kind.toLowerCase().replaceAll('_', '.'), data });
      work.catch(() => {});
      pending.push(work);
    },
  });
  await instance.messageHandle['messages.upsert']({ type: 'notify', messages: [payload] }, {});
  const outcomes = await Promise.allSettled(pending);
  return { effects, outcomes };
}

module.exports = { webhook, config, event, runOriginalMessageHandler };
