// The words and examples of agents.html. Kept apart from the page so a test can check them against the API's route list.

export const API = 'https://api.canopyrh.com';

export const RULES = [
  {title: 'No recipient field', body: 'The exit contract has no "send to" address, and no API route takes one. Every exit pays the position owner. A request that names a recipient, a receiver or a "to" is refused.'},
  {title: 'Exit Now and Disarm All are free', body: 'They never cost a plan, and the API never asks for payment. Keepers run automatic exits for paid wallets; the owner\'s own exit does not need them.'},
  {title: 'Agents can arm and tighten', body: 'An agent may arm a position and add alarms. Arming again replaces the position\'s keys, so always send every key the position should keep. Leaving one out loosens it.'},
  {title: 'Only owners loosen or disarm', body: 'Removing an alarm, disarming a position and Disarm All belong to the owner. Never give an agent the right to disarm, and never ask an owner to hand it over.'},
  {title: 'The API never signs', body: 'It reads the chain and builds calldata. It takes no private key, sends no transaction and keeps no wallet. The owner\'s wallet signs and sends.'},
  {title: 'No external audit yet', body: 'The contracts have had internal reviews only. Say so wherever you present Canopy to a person.'},
];

export const ROUTES = [
  {path: '/vaults', note: 'The vaults Canopy lists.'},
  {path: '/risk/{vault}', note: 'A vault\'s risk card, in plain words.'},
  {path: '/presets/{vault}', note: 'The alarm presets for a vault, with their keys.'},
  {path: '/alarms/live', note: 'Alarms that fired in the last day, newest first.'},
  {path: '/exits', note: 'The public exit log. No owner address is listed.'},
  {path: '/alarms/record', note: 'Every alarm that fired and what happened next.'},
  {path: '/board', note: 'What is armed right now, in totals.'},
  {path: '/status', note: 'Whether Canopy is running right now.'},
  {path: '/whales', note: 'Recent large deposits and withdrawals on the listed vaults.'},
  {path: '/watchers', note: 'The approved outside watchers and how often their signatures matched a real alarm.'},
  {path: '/xray/{file}', note: 'A vault\'s X-ray card. {file} is the vault address for a share page, or the address plus .png, .svg or .json.'},
  {path: '/calldata/arm?vault=&keys=', note: 'Approve and arm calls, after every key is checked on-chain.'},
  {path: '/calldata/exit?vault=&owner=', note: 'The owner\'s Exit Now call.'},
  {path: '/calldata/disarm-all', note: 'The Disarm All call. For owners only.'},
  {path: '/openapi.json', note: 'This API as an OpenAPI 3.1 document.'},
  {path: '/llms.txt', note: 'A short plain-text brief for language models.'},
];

export const EXAMPLES = [
  {
    id: 'presets',
    title: '1. Find a vault\'s alarm keys',
    body: 'Each preset has a key. These are the keys you pass to arm.',
    code: `curl ${API}/presets/0xBeEff033F34C046626B8D0A041844C5d1A5409dd`,
  },
  {
    id: 'arm',
    title: '2. Get the calls to arm',
    body: 'Every key is read from AlarmBook first. If one is not registered or cannot be armed now, you get a 422 that names it and nothing else.',
    code: `curl "${API}/calldata/arm?vault=0xBeEff033F34C046626B8D0A041844C5d1A5409dd&keys=0x<key1>,0x<key2>"

# {
#   "chainId": 4663,
#   "calls": [
#     { "step": "approve", "to": "<vault>",  "data": "0x095ea7b3...", "value": "0" },
#     { "step": "arm",     "to": "<router>", "data": "0x...",         "value": "0" }
#   ]
# }`,
  },
  {
    id: 'send',
    title: '3. Hand the calls to the owner\'s wallet',
    body: 'Send them in order from the owner\'s wallet. Skip approve if the router already has a large allowance. Canopy never sees the signature.',
    code: `import { createWalletClient, custom } from 'viem';

const res = await fetch(\`\${API}/calldata/arm?vault=\${vault}&keys=\${keys.join(',')}\`);
if (!res.ok) throw new Error((await res.json()).error);
const { calls } = await res.json();

const wallet = createWalletClient({ transport: custom(window.ethereum) });
const [account] = await wallet.getAddresses();
for (const { to, data } of calls) {
  await wallet.sendTransaction({ account, to, data, value: 0n });
}`,
  },
  {
    id: 'exit',
    title: '4. Exit Now',
    body: 'Returns the exit call for the owner\'s armed position. Funds go to the owner. If the position is not armed you get a 404: withdraw from the vault as usual.',
    code: `curl "${API}/calldata/exit?vault=0xBeEff033F34C046626B8D0A041844C5d1A5409dd&owner=0x<owner>"`,
  },
  {
    id: 'watch',
    title: '5. Watch the alarms and the log',
    body: 'Reads are limited per client address. A 429 carries Retry-After, in seconds.',
    code: `curl ${API}/alarms/live
curl "${API}/exits?limit=20"`,
  },
];

export const NOT_FOR_AGENTS = 'Disarm All: ' + API + '/calldata/disarm-all. It exists so an owner can stop everything in one transaction. Build it into an owner\'s own screen, never into an agent\'s tools.';
