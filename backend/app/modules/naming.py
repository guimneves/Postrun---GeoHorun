"""Geração de nomes de amostra e renumeração de réplicas (seção 6 da spec).

Formato: `AAAA-MM-DD_nomedaamostra_x` (hífen — ver correção registrada na
seção 6 do Prompt_refinado.md; os exemplos reais de TABSAMPLE usam hífen,
não barra como no prompt original, provavelmente porque `/` quebraria
caminhos de arquivo no Windows).

**Campo "Extra" (pedido do usuário, bug real)**: duas colaboradoras
cadastraram a mesma amostra-base com ciclos diferentes; a numeração de
réplica coincidiu e o mesmo nome de análise foi gravado duas vezes no
equipamento (arquivos de resultado conflitantes). O campo opcional
`extra` vira um diferenciador extra no nome —
`AAAA-MM-DD_nomedaamostra_extra_x` — inserido só quando não está em
branco; em branco, o formato antigo (`AAAA-MM-DD_nomedaamostra_x`)
continua valendo sem nenhuma mudança.
"""

from __future__ import annotations

from datetime import date


def generate_analysis_name(sample_date: date, base_name: str, replica: int, extra: str | None = None) -> str:
    extra = (extra or "").strip()
    if extra:
        return f"{sample_date:%Y-%m-%d}_{base_name}_{extra}_{replica}"
    return f"{sample_date:%Y-%m-%d}_{base_name}_{replica}"


def renumber_group(ordered_positions: list[int]) -> dict[int, int]:
    """Recebe as posições de um grupo de réplicas **já na ordem física
    resultante da seleção/arrasto** (resolvida por `app.modules.carousel`)
    e devolve {posição: número da réplica}, 1..N nessa ordem — regra
    confirmada na seção 6: "x é atribuído pela ordem das posições ocupadas
    pelo grupo de réplicas, na direção em que o grupo foi
    arrastado/selecionado"."""
    return {pos: i + 1 for i, pos in enumerate(ordered_positions)}


def regenerate_group_names(
    ordered_positions: list[int], sample_date: date, base_name: str, extra: str | None = None
) -> dict[int, str]:
    """Atalho: renumera o grupo e já devolve o nome completo por posição."""
    replicas = renumber_group(ordered_positions)
    return {
        pos: generate_analysis_name(sample_date, base_name, replica, extra)
        for pos, replica in replicas.items()
    }


# Pedido do usuário (2026-10-14): o RockSeven Supervisor dá conflito com
# pontuação no nome da análise — `.` `,` `/` `\` `:` `;` ficam proibidos no
# nome/código das amostras da biblioteca e no "extra" (tudo isso vira parte
# do nome `AAAA-MM-DD_código_extra_réplica` gravado no TABSAMPLE.txt).
# Nunca alteramos o nome sozinhos: recusamos com a mensagem e o usuário
# corrige. Registros antigos que já têm esses caracteres continuam listando
# normalmente (só a criação/edição é validada).
FORBIDDEN_NAME_CHARS = ".,/\\:;"


def forbidden_chars_in(value: str | None) -> list[str]:
    """Os caracteres proibidos presentes em `value`, na ordem da regra."""
    if not value:
        return []
    return [c for c in FORBIDDEN_NAME_CHARS if c in value]


def forbidden_chars_message(value: str | None, label: str) -> str | None:
    """Mensagem pronta para o usuário se `value` tem caractere proibido;
    `None` se está tudo certo."""
    found = forbidden_chars_in(value)
    if not found:
        return None
    return (
        f"{label}: não use {' '.join(found)} — o RockSeven Supervisor não aceita os caracteres "
        f"{' '.join(FORBIDDEN_NAME_CHARS)} no nome da amostra."
    )
