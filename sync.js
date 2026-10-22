// 9mm · Sync Envolvidos (GitHub Actions)
// 1) Junta as pessoas da coluna "Resp." de todos os subelementos na coluna "Resp." do item.
// 2) Se o item tiver uma coluna de texto "Em andamento", escreve nela os tipos de job
//    dos subelementos com status Em andamento (ex.: "Criação do Zero, Arte Final").
// As colunas são encontradas pelo NOME. Não precisa de IDs.

// ===== CONFIGURAÇÃO (só mude se renomear as colunas) =====
const BOARD_JOBS = 18436448382;
const NOME_PESSOAS_SUB = "Resp.";        // pessoas no subelemento (coluna nativa)
const NOME_PESSOAS_ITEM = "Resp.";       // pessoas no item (coluna do app)
const NOME_STATUS_SUB = "Status";        // status do subelemento
const NOME_TIPO_SUB = "Tipo de Job";     // tipo de job do subelemento
const NOME_EM_ANDAMENTO = "Em andamento"; // coluna de TEXTO no item (opcional)
const STATUS_EM_ANDAMENTO = "Em andamento";
const PULAR_GRUPOS = ["conclu"];         // grupos ignorados (nome contém)
// =========================================================

const TOKEN = process.env.MONDAY_TOKEN;
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

async function api(query, variables = {}) {
  const r = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: TOKEN, "API-Version": "2025-04" },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors || j.error_message) throw new Error(JSON.stringify(j.errors || j.error_message));
  return j.data;
}

const acha = (cols, nome, tipo) => cols.find(c => norm(c.title) === norm(nome) && (!tipo || c.type === tipo)) || null;
const pessoasDe = v => ((v && v.persons_and_teams) || []).map(p => ({ id: Number(p.id), kind: p.kind }));
const chave = l => l.map(p => `${p.kind}:${p.id}`).sort().join(",");
function juntar(listas) { const m = new Map(); for (const l of listas) for (const p of l) m.set(`${p.kind}:${p.id}`, p); return [...m.values()]; }
const cv = (lista, id) => (lista || []).find(c => c.id === id) || null;

async function main() {
  if (!TOKEN) throw new Error("Falta o segredo MONDAY_TOKEN no GitHub (Settings → Secrets and variables → Actions).");

  // colunas do item e dos subelementos
  const b = (await api(`query { boards(ids: [${BOARD_JOBS}]) { name groups { id title } columns { id title type settings_str } } }`)).boards[0];
  const subtasks = b.columns.find(c => c.type === "subtasks");
  const subBoardId = subtasks ? (JSON.parse(subtasks.settings_str || "{}").boardIds || [])[0] : null;
  if (!subBoardId) throw new Error("O board não tem subelementos.");
  const sb = (await api(`query { boards(ids: [${subBoardId}]) { columns { id title type } } }`)).boards[0];

  const pItem = acha(b.columns, NOME_PESSOAS_ITEM, "people");
  const pSub = acha(sb.columns, NOME_PESSOAS_SUB, "people");
  const tAnd = acha(b.columns, NOME_EM_ANDAMENTO, "text");
  const sSub = acha(sb.columns, NOME_STATUS_SUB);
  const tSub = acha(sb.columns, NOME_TIPO_SUB);
  if (!pItem) throw new Error(`Não achei a coluna de pessoas "${NOME_PESSOAS_ITEM}" no item.`);
  if (!pSub) throw new Error(`Não achei a coluna de pessoas "${NOME_PESSOAS_SUB}" nos subelementos.`);
  const usaAnd = !!(tAnd && sSub && tSub);
  console.log(`Board: ${b.name} · pessoas: ${pSub.id} → ${pItem.id}` + (usaAnd ? ` · em andamento: ${tAnd.id}` : " · coluna 'Em andamento' não encontrada (pulando)"));

  const colsItem = [pItem.id, ...(usaAnd ? [tAnd.id] : [])].map(x => `"${x}"`).join(",");
  const colsSub = [pSub.id, ...(usaAnd ? [sSub.id, tSub.id] : [])].map(x => `"${x}"`).join(",");
  const CAMPOS = `id name
    column_values(ids: [${colsItem}]) { id text ... on PeopleValue { persons_and_teams { id kind } } }
    subitems { column_values(ids: [${colsSub}]) { id text ... on PeopleValue { persons_and_teams { id kind } } } }`;

  const grupos = b.groups.filter(g => !PULAR_GRUPOS.some(p => norm(g.title).includes(p)));
  let vistos = 0, alterados = 0;
  for (const g of grupos) {
    let page = (await api(`query { boards(ids: [${BOARD_JOBS}]) { groups(ids: ["${g.id}"]) { items_page(limit: 50) { cursor items { ${CAMPOS} } } } } }`)).boards[0].groups[0].items_page;
    while (true) {
      for (const it of page.items) {
        vistos++;
        const valores = {};
        const novas = juntar((it.subitems || []).map(s => pessoasDe(cv(s.column_values, pSub.id))));
        if (chave(novas) !== chave(pessoasDe(cv(it.column_values, pItem.id)))) valores[pItem.id] = { personsAndTeams: novas };
        if (usaAnd) {
          const tipos = [];
          for (const s of it.subitems || []) {
            if (norm((cv(s.column_values, sSub.id) || {}).text) !== norm(STATUS_EM_ANDAMENTO)) continue;
            const t = ((cv(s.column_values, tSub.id) || {}).text || "").trim();
            if (t && !tipos.includes(t)) tipos.push(t);
          }
          const texto = tipos.join(", ");
          if (texto !== ((cv(it.column_values, tAnd.id) || {}).text || "")) valores[tAnd.id] = texto;
        }
        if (!Object.keys(valores).length) continue;
        await api(`mutation ($v: JSON!) { change_multiple_column_values(board_id: ${BOARD_JOBS}, item_id: ${it.id}, column_values: $v) { id } }`, { v: JSON.stringify(valores) });
        alterados++;
        console.log(`Atualizado: ${it.name}`);
      }
      if (!page.cursor) break;
      page = (await api(`query { next_items_page(limit: 50, cursor: "${page.cursor}") { cursor items { ${CAMPOS} } } }`)).next_items_page;
    }
  }
  console.log(`Pronto: ${vistos} jobs conferidos, ${alterados} atualizados.`);
}

if (require.main === module) main().catch(e => { console.error("Erro:", e.message); process.exit(1); });
module.exports = { main };
