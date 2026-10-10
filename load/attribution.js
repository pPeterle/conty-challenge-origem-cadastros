// Carga: cada iteração é um aparelho. Os reenvios do mesmo clique e do mesmo
// cadastro saem em paralelo (http.batch), e 20 VUs tocam aparelhos diferentes ao mesmo tempo.
// 20 VUs x 5 reenvios = até 100 conexões abertas de uma vez. Acima de ~128 o backlog
// de listen do macOS (kern.ipc.somaxconn) começa a recusar conexão antes de chegar no Node.
import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:3104";
const cfg = JSON.parse(open("./scenario.json"));
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

export const options = {
  scenarios: {
    aparelhos: { executor: "shared-iterations", vus: 20, iterations: cfg.installs, maxDuration: "2m" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200"],
    checks: ["rate>0.99"],
  },
};

const pad = (i) => String(i).padStart(6, "0");
const link = (src, extra, cid) => `https://conty.app/abrir?src=${src}&${extra}&cid=${cid}`;

function sendTouch(install, url) {
  const body = JSON.stringify({ install_id: install, url });
  const res = http.batch(Array.from({ length: cfg.touchDuplicates }, () => ["POST", `${BASE}/touches`, body, JSON_HEADERS]));
  check(res, {
    "toque: um 201 e o resto 200": (rs) =>
      rs.filter((r) => r.status === 201).length === 1 && rs.filter((r) => r.status === 200).length === rs.length - 1,
  });
}

function signup(install, user, expected) {
  const body = JSON.stringify({ install_id: install, user_id: user });
  const res = http.batch(Array.from({ length: cfg.signupDuplicates }, () => ["POST", `${BASE}/signups`, body, JSON_HEADERS]));
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

export default function () {
  const i = exec.scenario.iterationInTest;
  const install = `inst_${pad(i)}`;
  const user = `u_${pad(i)}`;
  const cidA = `clk_${pad(i)}_a`;
  const cidB = `clk_${pad(i)}_b`;

  switch (i % 4) {
    case 0: {
      // Sem link: só a primeira abertura (repetida) e o cadastro. Esperado: orgânico.
      const body = JSON.stringify({ install_id: install });
      http.batch([1, 2, 3].map(() => ["POST", `${BASE}/installs`, body, JSON_HEADERS]));
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
