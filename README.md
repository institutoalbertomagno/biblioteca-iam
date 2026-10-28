# Biblioteca IAM

Catálogo da biblioteca do Instituto Alberto Magno. Site em Cloudflare Pages, sem necessidade de conta Claude para quem o usa.

## O que faz

- Consultar o catálogo (capas, lista e folha tipo Excel), filtrar por classe CDU e por disponibilidade.
- Registar livros lendo o código de barras com a câmara (ISBN procurado no Google Books e no Open Library), escrevendo o ISBN, ou fotografando a capa.
- Ler a capa por fotografia e classificar pela CDU com o Claude, se houver chave da API (opcional).
- Empréstimos e devoluções, com aviso de atrasos.
- Descarregar o catálogo em Excel (.xlsx).
- Dois códigos de acesso: o da equipa (consultar, registar, emprestar) e o de gestão (também elimina e importa).

## Estrutura

```
public/               página (HTML, CSS, JS) e bibliotecas (leitor de códigos de barras, Excel)
functions/api/        servidor (Cloudflare Pages Functions): /api/...
```

## Configuração no Cloudflare (Pages)

- Build: sem comando de build; diretório de saída `public`.
- Bindings: D1 com o nome `DB`; R2 com o nome `CAPAS`.
- Segredos: `CODIGO_EQUIPA`, `CODIGO_GESTAO`, `SEGREDO`; opcional `ANTHROPIC_API_KEY` e `MODELO` (por omissão `claude-sonnet-5-5`).
- A tabela da base de dados cria-se sozinha no primeiro pedido.

## API

| Pedido | O que faz |
|---|---|
| `POST /api/entrar` `{codigo}` | Abre sessão (cookie de 180 dias) |
| `POST /api/sair` | Fecha a sessão |
| `GET /api/sessao` | Papel (`equipa`/`gestao`) e se a leitura por IA está ligada |
| `GET /api/livros` | Todos os livros |
| `POST /api/livros` | Novo livro |
| `PATCH /api/livros/:id` | Alterar campos (inclui empréstimos) |
| `DELETE /api/livros/:id` | Eliminar (só gestão) |
| `POST /api/capas` (imagem) | Guardar capa no R2 |
| `POST /api/capas/importar` `{url}` | Copiar capa do Google Books / Open Library |
| `GET /api/capas/:chave` | Ver capa |
| `GET /api/isbn/:isbn` | Procurar ISBN nos catálogos públicos |
| `POST /api/catalogar` `{imagens, pista}` | Ler capa / classificar com o Claude |
| `POST /api/importar` `{livros}` | Importar livros (só gestão) |

## Testar no computador

```
npx wrangler pages dev public --d1 DB=local --r2 CAPAS=local \
  --binding SEGREDO=teste --binding CODIGO_EQUIPA=1234 --binding CODIGO_GESTAO=9999
```
