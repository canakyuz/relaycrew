/**
 * @typedef {{key: string, values: number[]}} HistorySeries
 * @typedef {{buckets: string[], total: number[], series: HistorySeries[]}} HistoryPayload
 * @typedef {{key: string, value: number}} DistributionRow
 * @typedef {{requests?: number, connections?: number, inputTokens?: number, outputTokens?: number}} UsageCounters
 * @typedef {UsageCounters & {windows?: Record<string, UsageCounters>}} UsageEntry
 * @typedef {{kind?: string, refused?: string[]}} WorkspaceCaller
 * @typedef {{name: string, provider?: string, disabled?: boolean, unavailable?: boolean}} WorkspaceAccount
 * @typedef {{id?: string, session: string, account: string}} SessionPin
 * @typedef {Object} WorkspaceStatus
 * @property {boolean} [dashboardPreview]
 * @property {WorkspaceCaller} [caller]
 * @property {WorkspaceAccount[]} [accounts]
 * @property {{active?: number, known?: number, items?: unknown[]}} [sessions]
 * @property {Record<string, string|null>} [currentAccounts]
 * @property {string|null} [currentAccount]
 * @property {Record<string, UsageEntry>} [clients]
 * @property {Record<string, Record<string, UsageEntry>>} [usageDimensions]
 * @property {string[]} [configuredUsageDimensions]
 * @property {{running?: boolean}} [probe]
 * @property {SessionPin[]} [sessionPins]
 *
 * @typedef {{id: string, name: string, provider: string, disabled?: boolean}} TeamAccount
 * @typedef {UsageCounters & {lastUsed?: string|number|null}} MemberUsage
 * @typedef {{name: string, accounts: '*'|string[], maxConcurrent: number, active?: number, disabled?: boolean, usage?: MemberUsage}} TeamMember
 * @typedef {{enabled: boolean, revision: string, accounts: TeamAccount[], members: TeamMember[]}} TeamPayload
 * @typedef {{name: string, accounts?: '*'|string[], maxConcurrent?: number, disabled?: boolean}} MemberPayload
 * @typedef {{revision?: string, issuedKey?: string, applied?: boolean, warning?: string}} MutationPayload
 * @typedef {{epoch: number, key: string|null}} AuthContext
 * @typedef {'rotate'|'revoke'} MemberAction
 * @typedef {Object} WorkspaceState
 * @property {WorkspaceStatus|null} status
 * @property {string} view
 * @property {TeamPayload|null} team
 * @property {string|null} editing
 * @property {string|null} editRevision
 * @property {number} authEpoch
 * @property {HistoryPayload|null} history
 * @property {HistoryPayload|null} preview
 * @property {number|null} selected
 * @property {number} historyAt
 * @property {number} previewAt
 * @property {number} historySeq
 * @property {number} previewSeq
 * @property {string} distributionSort
 * @property {number} distributionDir
 * @property {number} teamAt
 * @property {{name: string, action: MemberAction, revision: string|null}|null} action
 * @property {boolean} submitting
 * @property {number} lastGood
 *
 * @typedef {{getElementById: (id: string) => any, querySelectorAll: (selector: string) => any[], createElement: (tag: string) => any, createElementNS: (namespace: string, tag: string) => any, title: string}} WorkspaceDocument
 * @typedef {{preventDefault: () => void, key?: string, currentTarget: any}} WorkspaceEvent
 * @typedef {{update: (status: WorkspaceStatus) => void, failed: (text: string) => void, signedOut: () => void, refresh?: () => void}} WorkspaceController
 * @typedef {{location: {hash: string}, navigator: {clipboard?: {writeText: (text: string) => Promise<void>}}, addEventListener: (name: string, listener: () => void) => void, RelayWorkspace: WorkspaceController}} WorkspaceWindow
 * @typedef {{workspaceDistribution: typeof workspaceDistribution, historyDistribution: typeof historyDistribution, validHistory: typeof validHistory, workspaceAdmin: typeof workspaceAdmin, historyPath: typeof historyPath}} WorkspaceHelpers
 */

/** @param {WorkspaceStatus|null} status @param {string} scope @param {string} windowKey @param {string} metric */
export function workspaceDistribution(status, scope, windowKey, metric) {
  const entries = scope === 'clients' ? status?.clients : status?.usageDimensions?.[scope.slice(10)];
  return Object.entries(entries || {}).map(([key, entry]) => {
    const counters = windowKey === 'total' ? entry : entry.windows?.[windowKey];
    const amount = Number(/** @type {Record<string, unknown>|undefined} */ (counters)?.[metric]);
    return { key, value: Number.isFinite(amount) && amount >= 0 ? amount : 0 };
  }).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

/** @param {HistoryPayload|null} data @param {number|null} [bucket] */
export function historyDistribution(data, bucket = null) {
  return (data?.series || []).map(series => ({
    key: String(series.key),
    value: bucket === null ? series.values.reduce((sum, value) => sum + value, 0) : (series.values[bucket] || 0),
  })).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

/** @param {unknown} data @returns {data is HistoryPayload} */
export function validHistory(data) {
  if (!data || typeof data !== 'object') return false;
  const candidate = /** @type {Partial<HistoryPayload>} */ (data);
  const { buckets, total, series } = candidate;
  return Array.isArray(buckets) && buckets.length <= 97
    && buckets.every(at => typeof at === 'string' && Number.isFinite(Date.parse(at)))
    && Array.isArray(total) && total.length === buckets.length
    && Array.isArray(series) && series.length <= 13
    && series.every(entry => typeof entry.key === 'string' && Array.isArray(entry.values)
      && entry.values.length === buckets.length && entry.values.every(value => Number.isFinite(value) && value >= 0))
    && total.every((value, i) => Number.isFinite(value) && value >= 0
      && value === series.reduce((sum, entry) => sum + entry.values[i], 0));
}

/** @param {WorkspaceCaller|null|undefined} caller @param {string|null} key */
export function workspaceAdmin(caller, key) {
  return !!key && caller?.kind !== 'client' && caller?.kind !== 'member'
    && !caller?.refused?.length;
}

/** @param {string} scope @param {string} windowKey @param {string} step @param {string} metric */
export function historyPath(scope, windowKey, step, metric) {
  if (!['5h', '24h'].includes(windowKey) || !['15m', '1h'].includes(step)
    || !['requests', 'inputTokens', 'outputTokens'].includes(metric)) return null;
  const query = new URLSearchParams({ scope: scope === 'clients' ? 'clients' : 'dimension', window: windowKey, step, metric });
  if (scope !== 'clients') {
    if (!scope.startsWith('dimension:') || !scope.slice(10)) return null;
    query.set('dimension', scope.slice(10));
  }
  return '/relaycrew/usage/history?' + query;
}

/** @param {WorkspaceDocument} document @param {WorkspaceWindow} window @param {typeof globalThis.fetch} fetch @param {{getItem: (key: string) => string|null}} localStorage @param {WorkspaceHelpers} helpers */
function bootWorkspace(document, window, fetch, localStorage, helpers) {
  'use strict';
  /** @param {string} id */
  var $ = function (id) { return document.getElementById(id); };
  /** @type {WorkspaceState} */
  var state = { status: null, view: '', team: null, editing: null, editRevision: null, authEpoch: 0,
    history: null, preview: null, selected: null, historyAt: 0, previewAt: 0,
    historySeq: 0, previewSeq: 0, distributionSort: 'value', distributionDir: -1,
    teamAt: 0, action: null, submitting: false, lastGood: 0 };
  /** @type {Promise<void>|null} */
  var teamRequest = null;
  /** @type {Record<string, string[]>} */
  var titles = {
    overview: ['Visão geral', 'Contas, conversas e consumo em um só lugar.', 'CONTROLE DO GATEWAY'],
    accounts: ['Contas', 'Cada provedor, sua cota e o próximo caminho para o tráfego.', 'CAPACIDADE E ROTEAMENTO'],
    team: ['Equipe', 'Acesso individual, permissões explícitas e limites claros.', 'QUEM PODE USAR'],
    usage: ['Uso', 'Entenda o consumo sem perder a origem de cada requisição.', 'ATIVIDADE E DISTRIBUIÇÃO'],
    sessions: ['Sessões', 'Acompanhe conversas, contexto e contas fixadas.', 'TRABALHO EM ANDAMENTO'],
    settings: ['Configurações', 'Ajustes do gateway e ações de operação.', 'SEU AMBIENTE']
  };
  var colors = ['#1c6be3', '#7197d5', '#8b7eb8', '#2b9196', '#b78a4a', '#ae6a83', '#608b54', '#6582a1', '#a2a7c3', '#ad875f', '#7a9c9b', '#9c729f', '#939aa6'];
  /** @param {number|null|undefined} n */
  var number = function (n) { return Number(n || 0).toLocaleString('pt-BR'); };
  /** @param {string} tag @param {string} [cls] @param {string|number} [text] @returns {any} */
  function node(tag, cls, text) {
    var element = document.createElement(tag);
    if (cls) element.className = cls;
    if (text != null) element.textContent = text;
    return element;
  }
  /** @param {string} text @param {(event: WorkspaceEvent) => void|Promise<void>} action @param {string} [cls] @returns {any} */
  function button(text, action, cls) {
    var element = node('button', cls || '', text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  }
  /** @param {string} id @param {string} text @param {string} [kind] */
  function message(id, text, kind) { $(id).textContent = text; $(id).className = 'notice ' + (kind || ''); }
  function key() { try { return localStorage.getItem('relaycrew-dashboard-key'); } catch { return null; } }
  function authContext() { return { epoch: state.authEpoch, key: key() }; }
  /** @param {AuthContext} context */
  function currentAuth(context) { return context.epoch === state.authEpoch && context.key === key(); }
  /** @param {AuthContext} context */
  function requireCurrentAuth(context) { if (!currentAuth(context)) throw new Error('Authentication context changed'); }
  function admin() { return state.status && helpers.workspaceAdmin(state.status.caller, key()); }
  function adminMessage() { return 'Use “Trocar chave” e informe a chave de administrador para acessar equipe e histórico. Chaves de clientes e membros não permitem esta operação.'; }
  /** @param {any} target @param {string} title @param {string} text */
  function empty(target, title, text) {
    target.textContent = '';
    var box = node('div', 'empty');
    box.appendChild(node('h2', '', title)); box.appendChild(node('p', '', text)); target.appendChild(box);
  }
  /** @param {unknown} error @returns {string} */
  function errorText(error) {
    if (error && typeof error === 'object') {
      if ('status' in error && (error.status === 401 || error.status === 403)) return adminMessage();
      if ('message' in error && typeof error.message === 'string' && error.message) return error.message;
    }
    return 'Não foi possível concluir a operação.';
  }
  /** @template T @param {string|null} path @param {object} [body] @param {AuthContext} [context] @returns {Promise<T>} */
  async function request(path, body, context = authContext()) {
    requireCurrentAuth(context);
    if (path === null) throw new Error('Consulta inválida para o gateway.');
    /** @type {RequestInit & {headers: Record<string, string>}} */
    var init = { headers: { 'x-api-key': context.key || '' }, cache: 'no-store' };
    if (body !== undefined) {
      init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body);
    }
    var response = await fetch(path, init);
    requireCurrentAuth(context);
    var data;
    try { data = await response.json(); } catch { requireCurrentAuth(context); throw new Error('Resposta inválida do gateway (HTTP ' + response.status + ').'); }
    requireCurrentAuth(context);
    if (!response.ok || data.ok === false) {
      var error = Object.assign(new Error(typeof data.error === 'string' ? data.error : 'Operação recusada (HTTP ' + response.status + ').'), { status: response.status });
      throw error;
    }
    return data;
  }
  function navigate() {
    var view = window.location.hash.slice(1);
    if (!Object.prototype.hasOwnProperty.call(titles, view)) view = 'overview';
    var changed = state.view !== view;
    state.view = view;
    document.querySelectorAll('[data-panel]').forEach(function (panel) { panel.hidden = panel.getAttribute('data-panel') !== view; });
    document.querySelectorAll('[data-view]').forEach(function (link) {
      if (link.getAttribute('data-view') === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('viewTitle').textContent = titles[view][0]; $('viewCrumb').textContent = titles[view][0];
    $('viewDescription').textContent = titles[view][1]; $('viewEyebrow').textContent = titles[view][2];
    document.title = titles[view][0] + ' · RelayCrew';
    if (changed && state.status) {
      if (view === 'team') loadTeam();
      if (view === 'usage') loadHistory(true);
      if (view === 'overview') loadPreview();
    }
  }
  /** @param {string} label @param {string} amount @param {string} caption */
  function stat(label, amount, caption) {
    var card = node('div', 'stat'); card.appendChild(node('span', '', label));
    card.appendChild(node('strong', '', amount)); card.appendChild(node('small', '', caption)); return card;
  }
  /** @param {WorkspaceStatus} status */
  function updateOverview(status) {
    var accounts = status.accounts || [], sessions = status.sessions || {};
    var ready = accounts.filter(function (account) { return !account.disabled && !account.unavailable; });
    var disabled = accounts.filter(function (account) { return account.disabled; }).length;
    var blocked = accounts.length - ready.length - disabled;
    var stats = $('overviewStats'); stats.textContent = '';
    stats.appendChild(stat('Contas disponíveis', number(ready.length), 'de ' + number(accounts.length) + ' configuradas'));
    stats.appendChild(stat('Conversas ativas', number(sessions.active), number(sessions.known) + ' conhecidas'));
    stats.appendChild(stat('Contas bloqueadas', number(blocked), 'indisponíveis para tráfego'));
    stats.appendChild(stat('Contas desativadas', number(disabled), 'fora da rotação'));
    $('overviewLead').textContent = !accounts.length ? 'Configure sua primeira conta para começar a encaminhar o tráfego da equipe.'
      : ready.length ? ready.length + ' ' + (ready.length === 1 ? 'conta disponível para receber tráfego.' : 'contas disponíveis para receber tráfego.')
        : 'Nenhuma conta disponível agora. Consulte os detalhes antes de enviar novas requisições.';
    var providers = $('providerSummary'); providers.textContent = '';
    /** @type {Record<string, WorkspaceAccount[]>} */
    var groups = Object.create(null);
    accounts.forEach(function (account) { var provider = account.provider || 'anthropic'; (groups[provider] || (groups[provider] = [])).push(account); });
    Object.keys(groups).sort().forEach(function (provider) {
      var list = groups[provider], available = list.filter(function (account) { return !account.disabled && !account.unavailable; });
      var row = node('div', 'provider-line'), info = node('div');
      info.appendChild(node('div', 'provider-name', provider === 'anthropic' ? 'Anthropic' : provider === 'codex' ? 'Codex / OpenAI' : provider));
      var current = status.currentAccounts ? status.currentAccounts[provider] : status.currentAccount;
      info.appendChild(node('small', '', current ? 'Em uso: ' + current : 'Sem conta ativa'));
      row.appendChild(info); row.appendChild(node('span', 'provider-count', available.length + ' / ' + list.length + ' disponíveis')); providers.appendChild(row);
    });
    if (!accounts.length) providers.appendChild(node('p', 'attention-clear', 'Nenhum provedor configurado. Adicione sua primeira conta pela CLI.'));
    var attention = $('overviewAttention'); attention.textContent = '';
    if (!$('problems').children.length) {
      var line = node('p', 'attention-clear');
      line.appendChild(node('b', '', accounts.length ? 'Nenhum alerta no status atual' : 'Vamos conectar a primeira conta'));
      line.appendChild(node('span', '', accounts.length ? 'As cotas e os bloqueios de cada conta estão na área Contas.' : 'Adicione uma conta pela CLI e recarregue a configuração.'));
      attention.appendChild(line);
    }
    $('accountsEmpty').hidden = !!accounts.length; $('accountCount').textContent = accounts.length + ' contas';
    var detailed = sessions.items;
    $('sessionsEmpty').hidden = !!detailed;
    if (detailed && !detailed.length) {
      $('sessionsEmpty').hidden = false;
      $('sessionsEmpty').querySelector('h2').textContent = 'Nenhuma conversa registrada';
      $('sessionsEmpty').querySelector('p').textContent = 'As conversas aparecerão aqui quando clientes enviarem tráfego pelo gateway.';
    } else if (!detailed) {
      $('sessionsEmpty').querySelector('h2').textContent = 'Detalhamento de sessões desativado';
      $('sessionsEmpty').querySelector('p').textContent = 'Ative proxy.sessionDetail na configuração para acompanhar conversas, contexto, cache e fixações por sessão.';
    }
    $('settingsProbe').textContent = status.probe?.running ? 'Consulta de cotas em andamento. O status será atualizado automaticamente.' : 'A consulta de cotas não está em execução.';
  }
  /** @param {WorkspaceStatus} status */
  function renderPins(status) {
    var target = $('sessionPinsList'); target.textContent = '';
    var allowed = admin(), pins = status.sessionPins || [];
    pins.forEach(function (pin) {
      var line = node('div', 'provider-line'); line.appendChild(node('span', '', pin.session + ' → ' + pin.account));
      const pinId = pin.id;
      if (allowed && pinId) line.appendChild(button('Desfixar', /** @param {WorkspaceEvent} event */ async function (event) {
        var context = authContext(), control = event.currentTarget; control.disabled = true;
        await savePin(pinId, null); if (currentAuth(context)) control.disabled = false;
      })); target.appendChild(line);
    });
    if (!pins.length) target.appendChild(node('p', 'muted', 'Nenhuma sessão fixada manualmente.'));
    var select = $('pinAccount'), chosen = select.value; select.textContent = '';
    (status.accounts || []).forEach(function (account) { var option = node('option', '', account.name); option.value = account.name; select.appendChild(option); });
    if ((status.accounts || []).some(function (account) { return account.name === chosen; })) select.value = chosen;
    $('pinSave').disabled = !allowed || !(status.accounts || []).length;
    $('pinSession').disabled = !allowed; select.disabled = !allowed;
    if (!allowed) message('sessionPinMessage', 'Use uma chave de administrador para alterar fixações.');
    else if (pins.some(function (pin) { return !pin.id; })) message('sessionPinMessage', 'Ative proxy.sessionDetail para desfixar as sessões existentes pelo painel. Novas fixações exigem o identificador completo.');
  }
  /** @param {string} sessionId @param {string|null} account */
  async function savePin(sessionId, account) {
    if (!admin()) return;
    var context = authContext();
    try {
      /** @type {{eligible?: boolean, seen?: boolean}} */
      var data = await request('/relaycrew/session-pin', { sessionId: sessionId, account: account }, context);
      if (!currentAuth(context)) return;
      message('sessionPinMessage', account === null ? 'Fixação removida. A sessão volta à rotação normal.' : data.eligible === false ? 'Conta fixada, mas indisponível para tráfego. Confira a cota e os bloqueios em Contas.' : 'Conta fixada para esta sessão.' + (data.seen === false ? ' O gateway ainda não observou este identificador.' : ''), data.eligible === false ? 'warn' : 'ok');
      if (window.RelayWorkspace.refresh) window.RelayWorkspace.refresh();
    } catch (error) { if (!currentAuth(context)) return; message('sessionPinMessage', errorText(error) + ' A alteração não foi repetida automaticamente.', 'error'); }
  }
  /** @param {WorkspaceStatus} status */
  function updateScopes(status) {
    var select = $('historyScope'), current = select.value;
    var names = Array.from(new Set(Object.keys(status.usageDimensions || {}).concat(status.configuredUsageDimensions || []))).sort();
    if (current.indexOf('dimension:') === 0 && names.indexOf(current.slice(10)) < 0) names.push(current.slice(10));
    var signature = names.join('\n');
    if (select.getAttribute('data-options') === signature) return;
    select.textContent = ''; var clients = node('option', '', 'Clientes'); clients.value = 'clients'; select.appendChild(clients);
    names.forEach(function (name) { var option = node('option', '', name); option.value = 'dimension:' + name; select.appendChild(option); });
    select.value = current || 'clients'; select.setAttribute('data-options', signature);
  }
  /** @param {WorkspaceStatus} status */
  function update(status) {
    state.status = status; state.lastGood = Date.now();
    if ($('previewLabel')) $('previewLabel').hidden = !status.dashboardPreview;
    $('connection').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    updateOverview(status); updateScopes(status); renderPins(status);
    document.querySelectorAll('th.sortable').forEach(function (header) {
      header.tabIndex = 0; header.setAttribute('role', 'columnheader');
      header.addEventListener('keydown', /** @param {WorkspaceEvent} event */ function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); header.click(); } });
    });
    if (state.view === 'overview' && Date.now() - state.previewAt > 30000) loadPreview();
    if (state.view === 'usage' && Date.now() - state.historyAt > 30000) loadHistory();
    if (state.view === 'team' && Date.now() - state.teamAt > 30000) loadTeam();
  }
  /** @param {string} text */
  function failed(text) {
    $('connection').textContent = state.lastGood ? 'Sem atualização · exibindo último status' : 'Sem conexão com o gateway';
    $('connection').title = text;
  }
  function signedOut() {
    state.team = null; state.history = null; state.preview = null; state.status = null;
    state.authEpoch++; state.historySeq++; state.previewSeq++;
    teamRequest = null; state.submitting = false; state.editing = null; state.editRevision = null; state.action = null;
    state.teamAt = 0; state.historyAt = 0; state.previewAt = 0;
    $('teamAdd').disabled = true; $('teamRefresh').disabled = false; $('memberSave').disabled = false; $('confirmAction').disabled = false; $('historyRefresh').disabled = false;
    $('pinSave').disabled = true;
    $('memberForm').reset(); $('memberName').value = ''; $('memberLimit').value = ''; $('memberAll').checked = false; $('memberDisabled').checked = false; $('memberAccounts').textContent = '';
    $('issuedKey').value = ''; $('issuedKey').textContent = '';
    ['teamMessage', 'memberError', 'confirmError', 'issuedMessage', 'sessionPinMessage'].forEach(function (id) { message(id, ''); });
    $('teamContent').textContent = ''; $('historyChart').textContent = ''; $('historyDistribution').textContent = ''; $('historyTable').textContent = ''; $('overviewHistory').textContent = '';
    ['memberDialog', 'confirmDialog', 'issuedDialog'].forEach(function (id) { if ($(id).open) $(id).close(); });
  }
  /** @param {string} tag @param {Record<string, string|number>} attrs @returns {any} */
  function svgElement(tag, attrs) {
    var element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { element.setAttribute(key, String(attrs[key])); }); return element;
  }
  /** @param {string|number} at @param {boolean} date */
  function timeLabel(at, date) {
    return new Date(at).toLocaleString('pt-BR', date ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  }
  /** @param {any} target @param {HistoryPayload} data @param {boolean} interactive */
  function chart(target, data, interactive) {
    target.textContent = '';
    if (!data.total.some(function (value) { return value > 0; })) {
      empty(target, 'Nenhum uso registrado neste período', 'O histórico começa com a atividade observada. Totais antigos não são transformados em amostras.'); return;
    }
    var plot = svgElement('svg', { viewBox: '0 0 1000 180', class: 'history-svg', role: interactive ? 'group' : 'img', 'aria-label': interactive ? 'Atividade por intervalo. A tabela abaixo contém os mesmos valores.' : 'Requisições por intervalo. Explore Uso para consultar todos os valores.' });
    var max = Math.max.apply(null, data.total.concat([1]));
    [0, 0.5, 1].forEach(function (fraction) {
      var y = 160 - fraction * 145;
      plot.appendChild(svgElement('line', { x1: 45, x2: 995, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
      var label = svgElement('text', { x: 0, y: y + 4, fill: 'var(--dim)', 'font-size': 10 }); label.textContent = number(Math.round(max * fraction)); plot.appendChild(label);
    });
    data.buckets.forEach(function (at, index) {
      var width = 950 / data.buckets.length, x = 45 + width * index, y = 160;
      var group = svgElement('g', interactive ? { role: 'button', tabindex: 0, 'aria-label': timeLabel(at, true) + ': ' + number(data.total[index]) + '. Filtrar distribuição.', 'aria-pressed': state.selected === index ? 'true' : 'false' } : {});
      group.appendChild(svgElement('rect', { x: x, y: 10, width: Math.max(width - 1, 1), height: 151, fill: 'transparent' }));
      data.series.forEach(function (series, seriesIndex) {
        var height = series.values[index] / max * 145; y -= height;
        group.appendChild(svgElement('rect', { x: x + 1, y: y, width: Math.max(width - 2, 1), height: height, rx: 1, fill: colors[seriesIndex % colors.length] }));
      });
      var title = svgElement('title', {}); title.textContent = timeLabel(at, true) + ' · ' + number(data.total[index]); group.appendChild(title);
      if (interactive) {
        var select = function () { state.selected = state.selected === index ? null : index; renderHistory(); };
        group.addEventListener('click', select);
        group.addEventListener('keydown', /** @param {WorkspaceEvent} event */ function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
      }
      plot.appendChild(group);
    });
    target.appendChild(plot);
    var labels = node('div', 'chart-labels');
    [data.buckets[0], data.buckets[Math.floor(data.buckets.length / 2)], data.buckets[data.buckets.length - 1]].forEach(function (at) { if (at) labels.appendChild(node('span', '', timeLabel(at, true))); });
    target.appendChild(labels);
    var legend = node('div', 'legend'); data.series.forEach(function (series, index) {
      var item = node('span', '', series.key === '(remaining)' ? 'Demais' : series.key), swatch = node('i'); swatch.style.background = colors[index % colors.length]; item.prepend(swatch); legend.appendChild(item);
    }); target.appendChild(legend);
    if (interactive) target.appendChild(node('p', 'chart-caption', 'Selecione um intervalo para ver sua distribuição. Horários no fuso deste navegador.'));
  }
  async function loadPreview() {
    if (!admin()) { empty($('overviewHistory'), 'Histórico disponível para administradores', adminMessage()); return; }
    state.previewAt = Date.now(); var seq = ++state.previewSeq, context = authContext();
    if (!state.preview) $('overviewHistory').textContent = 'Carregando atividade registrada…';
    try {
      var data = await request(helpers.historyPath('clients', '24h', '1h', 'requests'), undefined, context);
      if (!currentAuth(context) || seq !== state.previewSeq) return;
      if (!helpers.validHistory(data)) throw new Error('O histórico retornou valores inconsistentes.');
      state.preview = data; chart($('overviewHistory'), data, false);
      $('overviewHistory').appendChild(node('p', 'coverage-note', 'Requisições por cliente · somente atividade registrada · intervalos nas bordas podem estar incompletos. Explore Uso para consultar a tabela e as métricas.'));
    } catch (error) { if (currentAuth(context) && seq === state.previewSeq) empty($('overviewHistory'), 'Não foi possível atualizar o histórico', errorText(error) + ' Abra Uso para tentar novamente.'); }
  }
  function selection() { return { scope: $('historyScope').value, window: $('historyWindow').value, metric: $('historyMetric').value, step: $('historyStep').value }; }
  /** @param {boolean} [force] */
  async function loadHistory(force) {
    var choice = selection();
    $('historyRefresh').disabled = false;
    $('stepLabel').hidden = choice.window === 'total'; $('historyDetails').hidden = choice.window === 'total';
    if (choice.window === 'total') {
      state.historySeq++; state.historyAt = Date.now(); state.history = null; state.selected = null;
      $('historyChart').textContent = ''; $('historyTable').textContent = '';
      message('historyMessage', 'Total acumulado desde os registros disponíveis. Esta visão não tem linha do tempo.'); renderHistory(); return;
    }
    if (choice.metric === 'connections') {
      state.historySeq++; state.history = null; state.historyAt = Date.now();
      $('historyChart').textContent = ''; $('historyTable').textContent = ''; $('historyDistribution').textContent = '';
      message('historyMessage', 'O histórico não registra conexões WebSocket por intervalo. Selecione “Total acumulado” para consultar esse contador.', 'warn'); return;
    }
    if (!admin()) {
      state.historySeq++; state.history = null; state.historyAt = Date.now();
      $('historyChart').textContent = ''; $('historyTable').textContent = ''; $('historyDistribution').textContent = '';
      message('historyMessage', adminMessage(), 'warn'); return;
    }
    var seq = ++state.historySeq, context = authContext(); state.historyAt = Date.now();
    if (force) { state.selected = null; state.history = null; $('historyChart').textContent = ''; $('historyDistribution').textContent = ''; $('historyTable').textContent = ''; }
    message('historyMessage', 'Atualizando atividade registrada…'); $('historyRefresh').disabled = true;
    try {
      var data = await request(helpers.historyPath(choice.scope, choice.window, choice.step, choice.metric), undefined, context);
      if (!currentAuth(context) || seq !== state.historySeq) return;
      if (!helpers.validHistory(data)) throw new Error('O histórico retornou valores inconsistentes.');
      state.history = data;
      message('historyMessage', number(data.total.reduce(function (sum, value) { return sum + value; }, 0)) + ' ' + $('historyMetric').selectedOptions[0].textContent.toLowerCase() + ' no período · atualizado às ' + new Date().toLocaleTimeString('pt-BR'));
      renderHistory();
    } catch (error) {
      if (!currentAuth(context) || seq !== state.historySeq) return;
      message('historyMessage', 'Falha ao atualizar. ' + errorText(error) + (state.history ? ' O gráfico exibe a última resposta recebida.' : '') + ' Use “Atualizar” para tentar novamente.', 'error');
    } finally { if (currentAuth(context) && seq === state.historySeq) $('historyRefresh').disabled = false; }
  }
  function renderHistory() {
    var choice = selection(), data = state.history;
    var rows = choice.window === 'total' ? helpers.workspaceDistribution(state.status, choice.scope, 'total', choice.metric) : helpers.historyDistribution(data, state.selected);
    $('clearBucket').hidden = state.selected === null;
    $('distributionTitle').textContent = state.selected !== null && data ? 'Distribuição · ' + timeLabel(data.buckets[state.selected], true) : choice.window === 'total' ? 'Distribuição acumulada' : 'Distribuição no período';
    if (data) { chart($('historyChart'), data, true); renderHistoryTable(data); }
    renderDistribution(rows);
  }
  /** @param {DistributionRow[]} rows */
  function renderDistribution(rows) {
    var target = $('historyDistribution'); target.textContent = '';
    if (!rows.length) { empty(target, 'Nenhum consumo atribuído', 'O uso aparecerá quando os clientes enviarem tráfego identificado ao gateway.'); return; }
    rows = rows.slice().sort(function (a, b) { return state.distributionDir * (state.distributionSort === 'key' ? a.key.localeCompare(b.key) : a.value - b.value); });
    var total = rows.reduce(function (sum, row) { return sum + row.value; }, 0), max = Math.max.apply(null, rows.map(function (row) { return row.value; }).concat([1]));
    var controls = node('div', 'section-heading');
    ['key', 'value'].forEach(function (sort) {
      var control = button((sort === 'key' ? 'Nome' : 'Consumo') + (state.distributionSort === sort ? state.distributionDir < 0 ? ' ↓' : ' ↑' : ' ↕'), function () {
        state.distributionDir = state.distributionSort === sort ? -state.distributionDir : sort === 'key' ? 1 : -1; state.distributionSort = sort; renderDistribution(rows);
      }); control.setAttribute('aria-label', 'Ordenar por ' + (sort === 'key' ? 'nome' : 'consumo')); controls.appendChild(control);
    }); target.appendChild(controls);
    var list = node('div', 'distribution');
    var colorKeys = state.history ? state.history.series.map(function (series) { return series.key; }) : rows.map(function (row) { return row.key; }).sort();
    rows.forEach(function (row) {
      var line = node('div', 'distribution-line');
      line.appendChild(node('span', 'distribution-label', row.key === '(remaining)' ? 'Demais' : row.key));
      var bar = node('div', 'bar'), fill = node('i'); fill.style.width = (row.value / max * 100) + '%'; fill.style.background = colors[colorKeys.indexOf(row.key) % colors.length]; bar.appendChild(fill); bar.setAttribute('aria-hidden', 'true'); line.appendChild(bar);
      var amount = node('strong', '', number(row.value)); amount.title = total ? (row.value / total * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% do período' : 'Nenhum uso registrado'; line.appendChild(amount); list.appendChild(line);
    }); target.appendChild(list);
    target.appendChild(node('p', 'chart-caption', 'Total: ' + number(total) + ' · ' + rows.length + ' grupos · cada dimensão representa o mesmo tráfego por outro critério.'));
  }
  /** @param {HistoryPayload} data */
  function renderHistoryTable(data) {
    var target = $('historyTable'); target.textContent = '';
    var table = node('table'), caption = node('caption', 'chart-caption', 'Atividade registrada por intervalo · ' + $('historyMetric').selectedOptions[0].textContent); table.appendChild(caption);
    var head = node('thead'), headers = node('tr');
    ['Intervalo', 'Total'].concat(data.series.map(function (series) { return series.key; })).forEach(function (title) { var th = node('th', '', title); th.scope = 'col'; headers.appendChild(th); }); head.appendChild(headers); table.appendChild(head);
    var body = node('tbody'); data.buckets.forEach(function (at, index) {
      var row = node('tr'); var label = node('th', '', timeLabel(at, true)); label.scope = 'row'; row.appendChild(label);
      [data.total[index]].concat(data.series.map(function (series) { return series.values[index]; })).forEach(function (value) { row.appendChild(node('td', 'num', number(value))); }); body.appendChild(row);
    }); table.appendChild(body); target.appendChild(table);
  }
  /** @returns {Promise<void>} */
  function loadTeam() {
    if (teamRequest) return teamRequest;
    $('teamAdd').disabled = true;
    if (!admin()) { state.team = null; $('teamContent').textContent = ''; message('teamMessage', adminMessage(), 'warn'); return Promise.resolve(); }
    var context = authContext();
    state.teamAt = Date.now(); $('teamRefresh').disabled = true;
    message('teamMessage', 'Atualizando membros…');
    teamRequest = (async function () {
      try {
        /** @type {TeamPayload} */
        var data = await request('/relaycrew/team', undefined, context);
        if (!currentAuth(context) || !admin()) return;
        if (!Array.isArray(data.members) || !Array.isArray(data.accounts) || typeof data.revision !== 'string') throw new Error('Resposta de equipe inválida.');
        state.team = data; renderTeam();
        message('teamMessage', data.enabled ? 'As permissões valem para as contas identificadas abaixo. Nomes de membros são permanentes.' : 'O modo equipe está desativado. Ative-o no arquivo de configuração e recarregue o gateway.', data.enabled ? '' : 'warn');
        $('teamAdd').disabled = !data.enabled;
      } catch (error) {
        if (!currentAuth(context)) return;
        message('teamMessage', 'Falha ao atualizar. ' + errorText(error) + (state.team ? ' A lista pode estar desatualizada; nenhuma alteração está disponível até atualizar.' : ''), 'error'); state.team = null; renderTeam();
      } finally { if (currentAuth(context)) { teamRequest = null; $('teamRefresh').disabled = false; } }
    })();
    return teamRequest;
  }
  function renderTeam() {
    var target = $('teamContent'); target.textContent = '';
    const team = state.team;
    if (!team) return;
    if (!team.members.length) { empty(target, 'Uma equipe começa pelo primeiro acesso', 'Adicione um membro, escolha suas contas e entregue a chave individual com segurança.'); return; }
    /** @type {Record<string, string>} */
    var accounts = Object.create(null); team.accounts.forEach(function (account) { accounts[account.id] = account.name; });
    var table = node('table'), head = node('thead'), hr = node('tr');
    ['Membro', 'Contas permitidas', 'Concorrência', 'Requisições', 'Tokens entrada / saída', 'Último uso', 'Acesso', 'Ações'].forEach(function (label) { var th = node('th', '', label); th.scope = 'col'; hr.appendChild(th); }); head.appendChild(hr); table.appendChild(head);
    var body = node('tbody'); team.members.forEach(function (member) {
      var row = node('tr'), usage = member.usage || {};
      [member.name, member.accounts === '*' ? 'Todas · atuais e futuras' : member.accounts.length ? member.accounts.map(function (id) { return accounts[id] || id; }).join(', ') : 'Sem acesso à inferência', number(member.active) + ' / ' + number(member.maxConcurrent), number(usage.requests), number(usage.inputTokens) + ' / ' + number(usage.outputTokens), usage.lastUsed ? timeLabel(usage.lastUsed, true) : 'Ainda sem uso', member.disabled ? 'Desativado' : 'Ativo'].forEach(function (value) { row.appendChild(node('td', '', value)); });
      var actions = node('td'), buttons = node('div', 'button-row');
      buttons.appendChild(button('Editar', function () { openMember(member); }));
      buttons.appendChild(button('Girar chave', function () { confirmMember(member, 'rotate'); }));
      buttons.appendChild(button('Revogar', function () { confirmMember(member, 'revoke'); }));
      if (!team.enabled) buttons.querySelectorAll('button').forEach(/** @param {any} control */ function (control) { control.disabled = true; });
      actions.appendChild(buttons); row.appendChild(actions); body.appendChild(row);
    }); table.appendChild(body); target.appendChild(table);
  }
  /** @param {TeamMember|null} member */
  function openMember(member) {
    const team = state.team;
    if (!team?.enabled || !admin()) return;
    state.editing = member ? member.name : null; state.editRevision = team.revision;
    $('memberForm').reset(); $('memberName').value = member ? member.name : ''; $('memberName').readOnly = !!member;
    $('memberLimit').value = member ? member.maxConcurrent : 4; $('memberAll').checked = !!member && member.accounts === '*';
    $('memberDisabled').checked = !!member?.disabled; $('memberDisabledWrap').hidden = !member;
    $('memberTitle').textContent = member ? 'Editar ' + member.name : 'Adicionar membro'; $('memberSave').textContent = member ? 'Salvar permissões' : 'Criar membro e chave';
    var choices = $('memberAccounts'); choices.textContent = '';
    team.accounts.forEach(function (account) {
      var label = node('label', 'check-line'), input = node('input'); input.type = 'checkbox'; input.value = account.id; input.addEventListener('change', toggleAccounts);
      input.checked = !!member && Array.isArray(member.accounts) && member.accounts.indexOf(account.id) >= 0;
      label.appendChild(input); label.appendChild(node('span', '', account.name + ' · ' + account.provider + (account.disabled ? ' · desativada' : ''))); choices.appendChild(label);
    });
    if (member && Array.isArray(member.accounts)) member.accounts.forEach(function (id) {
      if (team.accounts.some(function (account) { return account.id === id; })) return;
      var label = node('label', 'check-line'), input = node('input'); input.type = 'checkbox'; input.value = id; input.checked = true; input.addEventListener('change', toggleAccounts);
      label.appendChild(input); label.appendChild(node('span', '', id + ' · conta ausente')); choices.appendChild(label);
    });
    if (!choices.children.length) choices.appendChild(node('p', 'muted', 'Nenhuma conta configurada. Adicione contas pela CLI ou escolha explicitamente todas as contas futuras.'));
    toggleAccounts(); $('memberDialog').showModal();
  }
  function toggleAccounts() {
    $('memberAccounts').querySelectorAll('input').forEach(/** @param {any} input */ function (input) { input.disabled = $('memberAll').checked; });
    message('memberError', !$('memberAll').checked && !$('memberAccounts').querySelectorAll('input:checked').length ? 'Sem acesso à inferência: este membro não poderá enviar requisições até receber uma conta.' : '', 'warn');
  }
  /** @param {MutationPayload} data @param {AuthContext} context */
  function revealKey(data, context) {
    if (!currentAuth(context) || !data.issuedKey) return;
    $('issuedKey').value = data.issuedKey;
    message('issuedMessage', data.applied === false ? 'A chave foi salva, mas a aplicação no gateway falhou. Guarde a chave e recarregue a configuração. ' + (data.warning || '') : 'A chave já está pronta para uso.');
    delete data.issuedKey; $('issuedDialog').showModal();
  }
  /** @param {'add'|'update'|MemberAction} action @param {MemberPayload} payload @param {string|null} revision @param {AuthContext} context @returns {Promise<MutationPayload>} */
  async function mutate(action, payload, revision, context) {
    requireCurrentAuth(context);
    if (!admin() || !state.team?.enabled) throw new Error(adminMessage());
    if (!revision) throw new Error('Atualize a equipe e abra a ação novamente para revisar as permissões.');
    /** @type {MutationPayload} */
    var data = await request('/relaycrew/team/' + action, Object.assign({ revision: revision }, payload), context);
    requireCurrentAuth(context);
    if (state.team && typeof data.revision === 'string') state.team.revision = data.revision;
    return data;
  }
  /** @param {string} name */
  function serverPolicy(name) {
    const team = state.team;
    if (!team) return 'Não foi possível consultar a política atual. Atualize a equipe antes de tentar novamente.';
    var member = team.members.find(function (entry) { return entry.name === name; });
    if (!member) return 'Política atual no servidor: o membro “' + name + '” não existe.';
    var grants = member.accounts === '*' ? 'todas as contas atuais e futuras' : !member.accounts.length ? 'sem acesso à inferência' : member.accounts.map(function (id) {
      var account = team.accounts.find(function (entry) { return entry.id === id; }); return account ? account.name + ' (' + id + ')' : id + ' (conta ausente)';
    }).join(', ');
    return 'Política atual no servidor para “' + name + '”: ' + grants + '; limite ' + member.maxConcurrent + '; ' + (member.disabled ? 'desativado' : 'ativo') + '.';
  }
  /** @param {unknown} error @param {string} target @param {string} name @param {AuthContext} context */
  async function conflictMessage(error, target, name, context) {
    if (!currentAuth(context)) return;
    if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
      if (teamRequest) await teamRequest;
      if (!currentAuth(context)) return;
      await loadTeam();
      if (!currentAuth(context)) return;
      if (target === 'memberError') state.editRevision = state.team?.revision || null;
      else if (state.action) state.action.revision = state.team?.revision || null;
      message(target, 'A configuração mudou. Seu rascunho foi mantido. ' + serverPolicy(name) + ' Revise as permissões e salve novamente para usar a revisão atual.', 'warn');
    } else message(target, errorText(error) + ' A operação não é repetida automaticamente. Se a conexão caiu, confira a lista antes de tentar novamente.', 'error');
  }
  $('memberForm').addEventListener('submit', /** @param {WorkspaceEvent} event */ async function (event) {
    event.preventDefault(); if (state.submitting) return;
    /** @type {'*'|string[]} */
    var accounts = $('memberAll').checked ? '*' : Array.from($('memberAccounts').querySelectorAll('input:checked')).map(/** @param {any} input */ function (input) { return input.value; });
    var limit = Number($('memberLimit').value);
    if (!Number.isInteger(limit) || limit < 1) { message('memberError', 'Escolha um limite inteiro maior que zero.', 'error'); return; }
    /** @type {MemberPayload} */
    var payload = { name: state.editing || $('memberName').value.trim(), accounts: accounts, maxConcurrent: limit };
    if (state.editing) payload.disabled = $('memberDisabled').checked;
    if (!payload.name) { message('memberError', 'Informe o nome do membro.', 'error'); return; }
    var context = authContext();
    state.submitting = true; $('memberSave').disabled = true; message('memberError', 'Salvando…');
    try {
      var data = await mutate(state.editing ? 'update' : 'add', payload, state.editRevision, context);
      if (!currentAuth(context)) return;
      $('memberDialog').close(); revealKey(data, context); await loadTeam();
      if (!currentAuth(context)) return;
      message('teamMessage', data.applied === false ? 'Alteração salva; aplicação no gateway pendente. Recarregue a configuração. ' + (data.warning || '') : 'Acesso salvo e aplicado ao gateway.', data.applied === false ? 'warn' : 'ok');
    } catch (error) { await conflictMessage(error, 'memberError', payload.name, context); }
    finally { if (currentAuth(context)) { state.submitting = false; $('memberSave').disabled = false; } }
  });
  /** @param {TeamMember} member @param {MemberAction} action */
  function confirmMember(member, action) {
    if (!state.team?.enabled || !admin()) return;
    state.action = { name: member.name, action: action, revision: state.team.revision };
    $('confirmTitle').textContent = (action === 'rotate' ? 'Girar chave de ' : 'Revogar acesso de ') + member.name + '?';
    $('confirmText').textContent = action === 'rotate' ? 'A chave anterior deixa de funcionar e o tráfego afetado será interrompido. Uma nova chave será exibida uma única vez.' : 'Esta ação desativa o acesso do membro. Sua chave deixará de funcionar e o tráfego afetado será interrompido. O registro será mantido e poderá ser reativado em Editar.';
    $('confirmAction').textContent = action === 'rotate' ? 'Girar chave agora' : 'Revogar acesso agora'; message('confirmError', ''); $('confirmDialog').showModal();
  }
  $('confirmAction').addEventListener('click', async function () {
    if (!state.action || state.submitting) return;
    var context = authContext(), action = state.action;
    state.submitting = true; $('confirmAction').disabled = true; message('confirmError', 'Aplicando alteração…');
    try {
      var data = await mutate(action.action, { name: action.name }, action.revision, context);
      if (!currentAuth(context)) return;
      $('confirmDialog').close(); revealKey(data, context); await loadTeam();
      if (!currentAuth(context)) return;
      message('teamMessage', data.applied === false ? 'Alteração salva; aplicação no gateway pendente. Recarregue a configuração. ' + (data.warning || '') : 'Alteração aplicada ao gateway.', data.applied === false ? 'warn' : 'ok');
    } catch (error) { await conflictMessage(error, 'confirmError', action.name, context); }
    finally { if (currentAuth(context)) { state.submitting = false; $('confirmAction').disabled = false; } }
  });
  $('copyKey').addEventListener('click', async function () {
    var context = authContext(), secret = $('issuedKey').value;
    if (!secret || !$('issuedDialog').open) return;
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await window.navigator.clipboard.writeText(secret);
      if (!currentAuth(context) || !$('issuedDialog').open || $('issuedKey').value !== secret) return;
      message('issuedMessage', 'Chave copiada. Guarde-a antes de fechar.', 'ok');
    } catch { if (!currentAuth(context) || !$('issuedDialog').open || $('issuedKey').value !== secret) return; $('issuedKey').focus(); $('issuedKey').select(); message('issuedMessage', 'Cópia automática indisponível. A chave foi selecionada: use Ctrl+C ou ⌘C.'); }
  });
  document.querySelectorAll('[data-close]').forEach(function (control) {
    control.addEventListener('click', function () { if (!state.submitting) $(control.getAttribute('data-close')).close(); });
  });
  ['memberDialog', 'confirmDialog'].forEach(function (id) { $(id).addEventListener('cancel', /** @param {WorkspaceEvent} event */ function (event) { if (state.submitting) event.preventDefault(); }); });
  $('issuedDialog').addEventListener('close', function () { $('issuedKey').value = ''; $('issuedKey').textContent = ''; message('issuedMessage', ''); });
  $('memberDialog').addEventListener('close', function () { $('memberForm').reset(); $('memberAccounts').textContent = ''; state.editing = null; state.editRevision = null; });
  $('confirmDialog').addEventListener('close', function () { state.action = null; });
  $('sessionPinForm').addEventListener('submit', /** @param {WorkspaceEvent} event */ async function (event) {
    event.preventDefault(); if ($('pinSave').disabled) return;
    var session = $('pinSession').value.trim(), account = $('pinAccount').value;
    if (!session || !account) return;
    var context = authContext();
    $('pinSave').disabled = true; await savePin(session, account); if (currentAuth(context)) $('pinSave').disabled = !admin();
  });
  $('memberAll').addEventListener('change', toggleAccounts);
  $('teamAdd').addEventListener('click', function () { openMember(null); }); $('teamRefresh').addEventListener('click', loadTeam);
  ['historyWindow', 'historyScope', 'historyMetric', 'historyStep'].forEach(function (id) { $(id).addEventListener('change', function () { loadHistory(true); }); });
  $('historyRefresh').addEventListener('click', function () { loadHistory(); });
  $('clearBucket').addEventListener('click', function () { state.selected = null; renderHistory(); });
  window.addEventListener('hashchange', navigate);
  window.RelayWorkspace = { update: update, failed: failed, signedOut: signedOut };
  navigate();
}

export const WORKSPACE_SCRIPT = '(' + bootWorkspace.toString() + ')(document,window,fetch,localStorage,{' +
  [workspaceDistribution, historyDistribution, validHistory, workspaceAdmin, historyPath].map(fn => fn.name + ':' + fn.toString()).join(',') + '});';
