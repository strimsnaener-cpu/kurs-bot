// Agent plugins: how each marketplace agent behaves at runtime.
// Adding an agent = one entry here (matched by the marketplace slug). Agents created in the admin
// panel without code use GENERIC until a plugin is added.

export const TOOLS = {
  save_lead: {
    type: 'function',
    function: {
      name: 'save_lead',
      description: 'Save contact details or an order request the customer gave. Call it as soon as they share a name, phone, email or order details.',
      parameters: { type: 'object', properties: {
        name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
        note: { type: 'string', description: 'What they want: product, size, quantity, delivery address, question.' },
      } },
    },
  },
  handoff_to_human: {
    type: 'function',
    function: {
      name: 'handoff_to_human',
      description: 'Pass the conversation to a human manager. Use when the customer asks for a person, is upset, or the request needs a decision you cannot make (refunds, complaints, custom deals, bulk orders), or the answer is not in the knowledge.',
      parameters: { type: 'object', properties: { reason: { type: 'string', description: 'One short sentence for the manager.' }, category: { type: 'string', description: 'For support: billing, delivery, technical, account, other.' } }, required: ['reason'] },
    },
  },
};

const CUSTOMER_FACING = ['save_lead', 'handoff_to_human'];
export const PLUGINS = {
  'telegram-assistant': {
    tools: CUSTOMER_FACING,
    role: 'You are a friendly customer assistant answering messages for a business in Telegram. Answer questions, share product information and prices from the knowledge, and collect contact details from interested customers.',
  },
  'instagram-assistant': {
    tools: CUSTOMER_FACING,
    role: 'You answer Instagram Direct messages for a business. Help customers choose products, explain services and prices from the knowledge, and collect order details (product, size, name, phone, delivery address).',
  },
  'sales-agent': {
    tools: CUSTOMER_FACING,
    role: 'You are an honest, skilled sales consultant. Ask one short question at a time to understand the need, recommend the best-fitting products from the knowledge, and answer objections (price, quality, delivery) with real facts and benefits. Never pressure, never invent discounts. When the customer is ready, collect their details to place the order.',
  },
  'support-agent': {
    tools: CUSTOMER_FACING,
    role: 'You are a calm, precise customer support agent. Solve the problem using the company knowledge. Identify the category of each issue (billing, delivery, technical, account, other). Escalate to a human with a clear one-line summary when the knowledge does not cover it or the customer needs an exception.',
  },
  'business-assistant': {
    tools: [],
    role: 'You are an internal assistant for the business owner and team. Summarize information, draft reports, organize tasks and workflows, and answer questions using the company knowledge. Be structured and concise; use short lists when helpful.',
  },
};
const GENERIC = { tools: CUSTOMER_FACING, role: 'You are a helpful assistant answering customer messages for a business.' };
export const pluginFor = slug => PLUGINS[slug] || GENERIC;

// Channels the runtime can run.
export const RUNTIME_CHANNELS = ['TELEGRAM', 'INSTAGRAM'];

// ---------- Customer-editable behavior settings ----------
export const LANGUAGES = { auto: 'Same as the customer', uk: 'Ukrainian', en: 'English', ru: 'Russian', pl: 'Polish', de: 'German' };
export const TONES = { friendly: 'warm and friendly, simple words', professional: 'polite and professional', concise: 'very brief and to the point' };

export function defaultConfig(orgName) {
  return {
    businessName: orgName.replace(/^Пространство /, ''),
    about: '',
    assistantName: 'Ассистент',
    tone: 'friendly',
    language: 'auto',
    greeting: 'Здравствуйте! 👋 Чем могу помочь?',
    handoffMessage: 'Спасибо! Я передал ваш вопрос менеджеру, он скоро ответит здесь.',
    collectLeads: true,
    extraInstructions: '',
  };
}

export function validateConfig(input, HttpError) {
  const c = input && typeof input === 'object' ? input : {};
  const s = (k, min, max) => {
    const v = typeof c[k] === 'string' ? c[k].trim() : '';
    if (v.length < min || v.length > max) throw new HttpError(400, `${LABELS[k]}: ${min ? `от ${min} до` : 'не более'} ${max} символов`);
    return v;
  };
  if (!Object.hasOwn(TONES, c.tone)) throw new HttpError(400, 'Выберите тон');
  if (!Object.hasOwn(LANGUAGES, c.language)) throw new HttpError(400, 'Выберите язык');
  return {
    businessName: s('businessName', 1, 80), about: s('about', 0, 3000), assistantName: s('assistantName', 1, 40),
    tone: c.tone, language: c.language, greeting: s('greeting', 1, 500), handoffMessage: s('handoffMessage', 1, 300),
    collectLeads: !!c.collectLeads, extraInstructions: s('extraInstructions', 0, 1500),
  };
}
const LABELS = { businessName: 'Название бизнеса', about: 'О вашем бизнесе', assistantName: 'Имя ассистента', greeting: 'Приветствие', handoffMessage: 'Сообщение при передаче менеджеру', extraInstructions: 'Дополнительные инструкции' };
