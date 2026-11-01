import { describe, expect, it } from 'vitest';
import {
  buildDesc,
  buildPrBody,
  buildTeamsMessage,
  ensureCommitPrefix,
  escapeHtml,
  extractTicketKey,
  normalizeTicketKey,
  safeHref,
  serviceFromRepo,
  stripTicketPrefix,
  ticketUrl,
} from '../src/message/index.js';

describe('extractTicketKey', () => {
  it.each([
    ['feature/LOGIS-3938-bulk-last-route', 'LOGIS-3938'],
    ['LOGIS-12', 'LOGIS-12'],
    ['bugfix/logis-77_fix-null', 'LOGIS-77'],
    ['hotfix/LOGIS-1001', 'LOGIS-1001'],
    ['feature/abc/LOGIS-5/sub', 'LOGIS-5'],
    ['release/LOGIS-3938.1', 'LOGIS-3938'],
  ])('%s → %s', (branch, key) => {
    expect(extractTicketKey(branch)).toBe(key);
  });

  it.each(['feature/bulk-last-route', 'feature/XLOGIS-12-foo', 'feature/LOGIS-abc', 'main'])('%s → null', (branch) => {
    expect(extractTicketKey(branch)).toBeNull();
  });

  it('mendukung project key lain', () => {
    expect(extractTicketKey('feature/TSOL-9-x', 'TSOL')).toBe('TSOL-9');
  });
});

describe('normalizeTicketKey', () => {
  it('menerima angka saja, huruf kecil, dan format penuh', () => {
    expect(normalizeTicketKey('3938')).toBe('LOGIS-3938');
    expect(normalizeTicketKey('logis-3938')).toBe('LOGIS-3938');
    expect(normalizeTicketKey(' LOGIS-3938 ')).toBe('LOGIS-3938');
  });
  it('menolak format salah', () => {
    expect(() => normalizeTicketKey('ABC-1')).toThrow(/tidak valid/);
    expect(() => normalizeTicketKey('LOGIS-')).toThrow(/tidak valid/);
  });
});

describe('serviceFromRepo', () => {
  it('membuang prefix SELOG_LOGIS_', () => {
    expect(serviceFromRepo('SELOG_LOGIS_ServiceOrder')).toBe('ServiceOrder');
    expect(serviceFromRepo('SELOG_LOGIS_ServiceVehicle', 'SELOG_LOGIS_')).toBe('ServiceVehicle');
  });
  it('tidak peka huruf besar/kecil untuk prefix', () => {
    expect(serviceFromRepo('selog_logis_ServiceOrder')).toBe('ServiceOrder');
  });
  it('mengembalikan nama repo apa adanya bila prefix tidak cocok', () => {
    expect(serviceFromRepo('other-repo')).toBe('other-repo');
    expect(serviceFromRepo('SELOG_LOGIS_')).toBe('SELOG_LOGIS_');
  });
});

describe('buildDesc', () => {
  const summary = '[Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment';

  it('menambahkan " in [Service]" bila belum ada', () => {
    expect(buildDesc(summary, 'ServiceOrder')).toBe(`${summary} in [ServiceOrder]`);
  });
  it('tidak menggandakan suffix yang sudah ada', () => {
    expect(buildDesc(`${summary} in [ServiceOrder]`, 'ServiceOrder')).toBe(`${summary} in [ServiceOrder]`);
  });
  it('perbandingan suffix case-insensitive dan summary di-trim', () => {
    expect(buildDesc(`  ${summary} IN [serviceorder]  `, 'ServiceOrder')).toBe(`${summary} IN [serviceorder]`);
  });
  it('service berbeda tetap ditambahkan', () => {
    expect(buildDesc(`${summary} in [ServiceVehicle]`, 'ServiceOrder')).toBe(
      `${summary} in [ServiceVehicle] in [ServiceOrder]`,
    );
  });
});

describe('ensureCommitPrefix', () => {
  it('menambahkan prefix bila belum ada', () => {
    expect(ensureCommitPrefix('tambah validasi', 'LOGIS-3938')).toBe('LOGIS-3938: tambah validasi');
  });
  it.each(['LOGIS-3938: x', 'logis-3938 x', '[LOGIS-3938] x', 'LOGIS-3938'])('tidak menggandakan: %s', (m) => {
    expect(ensureCommitPrefix(m, 'LOGIS-3938')).toBe(m);
  });
  it('key lain (LOGIS-39380) tetap diberi prefix', () => {
    expect(ensureCommitPrefix('LOGIS-39380: x', 'LOGIS-3938')).toBe('LOGIS-3938: LOGIS-39380: x');
  });
  it.each([
    'ver:1.0.0 tkt:LOGIS-3938 msg:add logis-pr guide',
    'ver:1.0.0 tkt:logis-3938 msg:x',
    'fix(order): null check (LOGIS-3938)',
  ])('key di tengah pesan → tidak diberi prefix: %s', (m) => {
    expect(ensureCommitPrefix(m, 'LOGIS-3938')).toBe(m);
  });
  it('format tim dengan key lain tetap diberi prefix', () => {
    expect(ensureCommitPrefix('ver:1.0.0 tkt:LOGIS-39380 msg:x', 'LOGIS-3938')).toBe(
      'LOGIS-3938: ver:1.0.0 tkt:LOGIS-39380 msg:x',
    );
  });
  it('menolak pesan kosong', () => {
    expect(() => ensureCommitPrefix('   ', 'LOGIS-1')).toThrow(/kosong/);
  });
});

describe('stripTicketPrefix', () => {
  it.each([
    ['LOGIS-3938: tambah x', 'tambah x'],
    ['[LOGIS-3938] tambah x', 'tambah x'],
    ['tambah x', 'tambah x'],
  ])('%s → %s', (input, out) => {
    expect(stripTicketPrefix(input, 'LOGIS-3938')).toBe(out);
  });
});

describe('buildTeamsMessage', () => {
  const input = {
    ticketKey: 'LOGIS-3938',
    desc: '[Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment in [ServiceOrder]',
    prUrl: 'https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder/pull/1886',
    ticketUrl: ticketUrl('https://serasiautoraya.atlassian.net/', 'LOGIS-3938'),
  };

  it('format text PERSIS sesuai kesepakatan tim', () => {
    expect(buildTeamsMessage(input).text).toBe(
      [
        'Task: Review PR LOGIS-3938',
        'Desc: [Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment in [ServiceOrder]',
        '',
        'PR: https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder/pull/1886',
        'Tiket: https://serasiautoraya.atlassian.net/browse/LOGIS-3938',
      ].join('\n'),
    );
  });

  it('format html: <br>, baris kosong, dan link yang bisa diklik', () => {
    expect(buildTeamsMessage(input).html).toBe(
      'Task: Review PR LOGIS-3938<br>' +
        'Desc: [Backend] Enhance Bulk Last Route Location Response for Shipment and Driver Enrichment in [ServiceOrder]<br>' +
        '<br>' +
        'PR: <a href="https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder/pull/1886">' +
        'https://github.com/developerserasiautoraya/SELOG_LOGIS_ServiceOrder/pull/1886</a><br>' +
        'Tiket: <a href="https://serasiautoraya.atlassian.net/browse/LOGIS-3938">' +
        'https://serasiautoraya.atlassian.net/browse/LOGIS-3938</a>',
    );
  });

  it('meng-escape karakter HTML di Desc (text tetap polos)', () => {
    const msg = buildTeamsMessage({ ...input, desc: `Fix <script>alert("x")</script> & 'quote' in [ServiceOrder]` });
    expect(msg.html).toContain(
      'Desc: Fix &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quote&#39; in [ServiceOrder]<br>',
    );
    expect(msg.html).not.toContain('<script>');
    expect(msg.text).toContain(`Desc: Fix <script>alert("x")</script> & 'quote' in [ServiceOrder]`);
  });

  it('meng-escape URL di atribut href', () => {
    const msg = buildTeamsMessage({ ...input, prUrl: 'https://github.com/o/r/pull/1?a=1&b="2"' });
    expect(msg.html).toContain('<a href="https://github.com/o/r/pull/1?a=1&amp;b=&quot;2&quot;">');
  });

  it('2 PR (hotfix): baris "PR (<base>)" untuk masing-masing, satu PR tetap format standar', () => {
    const prs = [
      { base: 'production', url: 'https://github.com/o/r/pull/1' },
      { base: 'development', url: 'https://github.com/o/r/pull/2' },
    ];
    const msg = buildTeamsMessage({ ...input, prs });
    expect(msg.text.split('\n')).toEqual([
      'Task: Review PR LOGIS-3938',
      `Desc: ${input.desc}`,
      '',
      'PR (production): https://github.com/o/r/pull/1',
      'PR (development): https://github.com/o/r/pull/2',
      `Tiket: ${input.ticketUrl}`,
    ]);
    expect(msg.html).toContain('PR (production): <a href="https://github.com/o/r/pull/1">');
    expect(buildTeamsMessage({ ...input, prs: [prs[1]!] }).text).toBe(buildTeamsMessage(input).text);
  });

  it('menolak href non-http(s)', () => {
    expect(() => safeHref('javascript:alert(1)')).toThrow(/tidak diizinkan/);
    expect(() => buildTeamsMessage({ ...input, prUrl: 'javascript:alert(1)' })).toThrow();
  });
});

describe('escapeHtml', () => {
  it('meng-escape kelima karakter khusus', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('buildPrBody', () => {
  it('berisi link tiket dan summary', () => {
    const body = buildPrBody({ ticketKey: 'LOGIS-1', ticketUrl: 'https://x/browse/LOGIS-1', summary: 'Hello' });
    expect(body).toContain('Tiket: [LOGIS-1](https://x/browse/LOGIS-1)');
    expect(body).toContain('Hello');
  });
});
