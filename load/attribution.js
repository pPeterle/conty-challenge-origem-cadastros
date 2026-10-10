// Carga: cada iteração é um aparelho. Os reenvios do mesmo clique e do mesmo
// cadastro saem em paralelo (http.batch), e 50 VUs tocam aparelhos diferentes ao mesmo tempo.
// Se os 50 VUs abrirem as 250 conexões no mesmo instante, a fila de listen do macOS
// (kern.ipc.somaxconn = 128) descarta SYN e o k6 vê connection refused/EOF. Por isso
// cada VU espera um pouco antes da primeira iteração; depois as conexões são reaproveitadas.
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3104";
const cfg = JSON.parse(open("./scenario.json"));
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

// 4xx dos payloads inválidos são respostas esperadas, não falhas.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 400, 404, 409, 413));

export const options = {
  scenarios: {
    aparelhos: { executor: "shared-iterations", vus: 50, iterations: cfg.installs, maxDuration: "2m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200"],
    checks: ["rate>0.99"],
  },
};

// O app real reenvia quando a rede falha; como toque e cadastro são idempotentes, reenviar é
// seguro. Aqui só reenviamos falhas de conexão (status 0), nunca uma resposta HTTP.
function batchWithRetry(reqs) {
  const res = http.batch(reqs);
  for (let i = 0; i < res.length; i++) {
    for (let attempt = 0; attempt < 3 && res[i].status === 0; attempt++) {
      sleep(0.05 * (attempt + 1));
      const [method, url, body, params] = reqs[i];
      res[i] = http.request(method, url, body, params);
    }
  }
  return res;
}

const pad = (i) => String(i).padStart(6, "0");
const link = (src, extra, cid) => `https://conty.app/abrir?src=${src}&${extra}&cid=${cid}`;

function sendTouch(install, url) {
  const body = JSON.stringify({ install_id: install, url });
  const res = batchWithRetry(Array.from({ length: cfg.touchDuplicates }, () => ["POST", `${BASE}/touches`, body, JSON_HEADERS]));
  check(res, {
    "toque: um 201 e o resto 200": (rs) =>
      rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status === 200).length === rs.length - 1,
  });
}

function signup(install, user, expected) {
  const body = JSON.stringify({ install_id: install, user_id: user });
  const res = batchWithRetry(Array.from({ length: cfg.signupDuplicates }, () => ["POST", `${BASE}/signups`, body, JSON_HEADERS]));
  check(res, {
    "cadastro: um 201 e o resto 200": (rs) =>
      rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status === 200).length === rs.length - 1,
    "cadastro: todas as respostas com a origem esperada": (rs) =>
      rs.every((r) => {
        const o = r.json("origem");
        return o && o.tipo === expected.tipo && o.click_id === expected.click_id;
      }),
  });
}

// Payloads inválidos que nunca podem gravar nada: a verificação final conta as linhas exatas.
const GARBAGE = [
  () => http.post(`${BASE}/touches`, "{install_id: oops", JSON_HEADERS),
  () => http.post(`${BASE}/signups`, "null", JSON_HEADERS),
  () => http.post(`${BASE}/installs`, JSON.stringify([{ install_id: "inst_x" }]), JSON_HEADERS),
  () => http.post(`${BASE}/installs`, JSON.stringify({ install_id: 12345 }), JSON_HEADERS),
  () => http.post(`${BASE}/signups`, JSON.stringify({ install_id: "inst x", user_id: "u_x" }), JSON_HEADERS),
  () => http.post(`${BASE}/signups`, JSON.stringify({ install_id: "inst_ção", user_id: "" }), JSON_HEADERS),
  () => http.post(`${BASE}/touches`, JSON.stringify({ install_id: "lixo_1", url: "https://conty.app/abrir?src=campanha&cmp=x" }), JSON_HEADERS),
  () => http.post(`${BASE}/touches`, JSON.stringify({ install_id: "lixo_2", url: "javascript:alert(1)" }), JSON_HEADERS),
  () => http.post(`${BASE}/touches`, JSON.stringify({ install_id: "lixo_3", url: "https://conty.app/abrir?src=google&cid=clk_lixo0001" }), JSON_HEADERS),
  () => http.post(`${BASE}/touches`, JSON.stringify({ install_id: "lixo_4", url: link("campanha", "cmp=x", "clk_lixo0002"), opened_at: "2026-03-01" }), JSON_HEADERS),
  () => http.post(`${BASE}/touches`, JSON.stringify({ install_id: "lixo_5", url: "x".repeat(20000) }), JSON_HEADERS),
  () => http.get(`${BASE}/signups/nao_existe_${Math.floor(Math.random() * 1e6)}/attribution`),
  () => http.get(`${BASE}/l?src=indicacao`),
  () => http.del(`${BASE}/touches`),
];

function garbage() {
  const res = GARBAGE[Math.floor(Math.random() * GARBAGE.length)]();
  check(res, {
    "payload inválido: 4xx com erro JSON": (r) => r.status >= 400 && r.status < 500 && r.json("error.code") !== undefined,
  });
}

export default function () {
  // Espalha a abertura das conexões dos VUs em ~1 s (ver comentário no topo).
  if (exec.vu.iterationInInstance === 0) sleep((exec.vu.idInTest - 1) * 0.02);
  if (Math.random() < 0.1) garbage();
  const i = exec.scenario.iterationInTest;
  const install = `inst_${pad(i)}`;
  const user = `u_${pad(i)}`;
  const cidA = `clk_${pad(i)}_a`;
  const cidB = `clk_${pad(i)}_b`;

  switch (i % 4) {
    case 0: {
      // Sem link: só a primeira abertura (repetida) e o cadastro. Esperado: orgânico.
      const body = JSON.stringify({ install_id: install, first_open_at: new Date().toISOString() });
      batchWithRetry([1, 2, 3].map(() => ["POST", `${BASE}/installs`, body, JSON_HEADERS]));
      signup(install, user, { tipo: "organico", click_id: null });
      break;
    }
    case 1: {
      sendTouch(install, link("campanha", "cmp=cmp_load&ch=instagram", cidA));
      signup(install, user, { tipo: "campanha", click_id: cidA });
      break;
    }
    case 2: {
      // Dois links: indicação e depois campanha. Campanha vence por ser mais recente
      // (e também venceria um empate de milissegundo, pela prioridade).
      sendTouch(install, link("indicacao", "ref=REF_LOAD", cidA));
      sendTouch(install, link("campanha", "cmp=cmp_load", cidB));
      signup(install, user, { tipo: "campanha", click_id: cidB });
      break;
    }
    case 3: {
      // Toque depois do cadastro: registrado, mas não muda a origem.
      sendTouch(install, link("indicacao", "ref=REF_LOAD", cidA));
      signup(install, user, { tipo: "indicacao", click_id: cidA });
      sendTouch(install, link("comunidade", "com=grupo_load", cidB));
      break;
    }
  }
}
