import { el } from './dom.ts';
import { opsFor } from '../../lib/notion-filter.ts';

type Raw = Record<string, any>;
/** Preserve every untouched upstream rule; only changed top-level fields enter the PATCH. */
export function createNotionViewFilters(view: Raw, properties: Raw[], changed: () => void) {
  let filter: Raw | null = structuredClone(view.filter ?? null), sorts: Raw[] = structuredClone(view.sorts ?? []), grouping: Raw | null = structuredClone(view.configuration?.group_by ?? null);
  const element = el('section', 'nbn-view-rules'), filters = el('div'), sortList = el('div'), groups = el('div');
  const emptyOps = new Set(['is_empty', 'is_not_empty', 'past_week', 'past_month', 'past_year', 'next_week', 'next_month', 'next_year', 'this_week', 'this_month', 'this_year']);
  const ops: Record<string, string[]> = Object.fromEntries(properties.map(p => [p.type, opsFor(p.type)]));
  const property = (id: string) => properties.find(p => p.id === id || p.name === id);
  function button(label: string, action: () => void) { const b = el('button', 'btn', label); b.type = 'button'; b.onclick = action; return b; }
  function select(label: string, entries: [string, string][], selected: string, change: (value: string) => void) {
    const root = el('label', 'nbn-field', label), input = el('select', 'input'); input.setAttribute('aria-label', label);
    for (const [value, name] of entries) input.append(new Option(name, value));
    if (selected && !entries.some(([value]) => value === selected)) input.append(new Option(selected, selected));
    input.value = selected; input.onchange = () => change(input.value); root.append(input); return root;
  }
  function input(label: string, value: string, type: string, change: (value: string) => void) {
    const root = el('label', 'nbn-field', label), control = el('input', 'input'); control.type = type; control.value = value; control.oninput = () => change(control.value); root.append(control); return root;
  }
  const editable = properties.filter(p => ops[p.type]?.length);
  function defaultRule(p: Raw) { const op = ops[p.type]?.includes('is_not_empty') ? 'is_not_empty' : ops[p.type]?.[0] ?? 'equals'; return { property: p.id, [p.type]: { [op]: emptyOps.has(op) ? (op.startsWith('is_') ? true : {}) : p.type === 'checkbox' ? true : p.type === 'number' || p.type === 'unique_id' ? 0 : '' } }; }
  const newRule = () => editable[0] ? defaultRule(editable[0]) : null;
  function condition(rule: Raw, update: (next: Raw) => void): HTMLElement {
    const row = el('div', 'nbn-rule'), p = property(rule.property ?? rule.timestamp), kind = p?.type ?? rule.timestamp;
    const expression = rule[kind], operator = expression && typeof expression === 'object' ? Object.keys(expression)[0] : undefined;
    if (!p || !ops[kind]?.length || !operator || !ops[kind]!.includes(operator) || Object.keys(expression).length !== 1) {
      row.append(el('p', '', 'This saved rule is preserved. Edit its advanced condition in Notion.')); return row;
    }
    row.append(select('Property', editable.map(p => [p.id, p.name]), p.id, id => {
      const next = property(id)!; update(defaultRule(next));
    }));
    row.append(select('Condition', ops[kind]!.map(op => [op, op.replaceAll('_', ' ')]), operator, op => {
      update({ ...rule, [kind]: { [op]: emptyOps.has(op) ? (op.startsWith('is_') ? true : {}) : kind === 'checkbox' ? true : (kind === 'number' || kind === 'unique_id') ? 0 : '' } });
    }));
    if (!emptyOps.has(operator)) {
      const value = expression[operator];
      const write = (value: unknown) => { expression[operator!] = value; changed(); };
      if (kind === 'checkbox') row.append(select('Value', [['true', 'Checked'], ['false', 'Unchecked']], String(value), v => write(v === 'true')));
      else if (['select', 'status', 'multi_select'].includes(kind) && p[kind]?.options?.length) {
        const root = el('label', 'nbn-field', 'Value'), choice = el('select', 'input'); choice.setAttribute('aria-label', 'Filter value'); choice.multiple = Array.isArray(value);
        const current = Array.isArray(value) ? value : [value];
        const values = [...new Set([...p[kind].options.map((o: Raw) => o.name), ...current])];
        for (const name of values) choice.append(new Option(String(name), String(name), false, current.includes(name)));
        choice.onchange = () => write(choice.multiple ? [...choice.selectedOptions].map(o => o.value) : choice.value); root.append(choice); row.append(root);
      } else row.append(input(kind === 'relation' || kind === 'people' ? 'Page or person ID' : 'Value', String(value ?? ''), (kind === 'number' || kind === 'unique_id') ? 'number' : 'text', v => write((kind === 'number' || kind === 'unique_id') ? v === '' ? null : Number(v) : v)));
    }
    return row;
  }
  function filterEditor(rule: Raw, update: (next: Raw) => void, depth = 0): HTMLElement {
    const root = el('div', 'nbn-filter-group'), mode = Array.isArray(rule.and) ? 'and' : Array.isArray(rule.or) ? 'or' : null;
    if (!mode) return condition(rule, next => { update(next); changed(); paintFilters(); });
    const children = rule[mode] as Raw[];
    root.append(select('Match', [['and', 'All conditions'], ['or', 'Any condition']], mode, next => { update({ [next]: children }); changed(); paintFilters(); }));
    children.forEach((child, index) => { const row = el('div', 'nbn-filter-child'); row.append(filterEditor(child, next => { children[index] = next; }, depth + 1), button('Remove condition', () => { children.splice(index, 1); changed(); paintFilters(); })); root.append(row); });
    root.append(button('Add condition', () => { const value = newRule(); if (value) children.push(value); changed(); paintFilters(); }));
    if (depth === 0) root.append(button('Add condition group', () => { const value = newRule(); if (value) children.push({ and: [value] }); changed(); paintFilters(); }));
    return root;
  }
  function paintFilters() {
    filters.replaceChildren(el('h4', '', 'Shared filters'));
    if (filter) filters.append(filterEditor(filter, next => { filter = next; }), button('Remove all filters', () => { filter = null; changed(); paintFilters(); }));
    else filters.append(el('p', '', 'No saved filter.'), button('Add filter', () => { const value = newRule(); if (value) filter = { and: [value] }; changed(); paintFilters(); }));
    if (filter && !filter.and && !filter.or) filters.append(button('Add another condition', () => { const value = newRule(); if (value) filter = { and: [filter!, value] }; changed(); paintFilters(); }));
  }
  function paintSorts() {
    sortList.replaceChildren(el('h4', '', 'Shared sort order'));
    sorts.forEach((sort, index) => {
      const row = el('div', 'nbn-sort'); row.append(select('Sort property', properties.map(p => [p.id, p.name]), property(sort.property)?.id ?? sort.timestamp ?? sort.property ?? '', id => { sorts[index] = { property: id, direction: sort.direction }; changed(); paintSorts(); }),
        select('Direction', [['ascending', 'Ascending'], ['descending', 'Descending']], sort.direction ?? 'ascending', value => { sort.direction = value; changed(); }),
        button('Move earlier', () => { if (index) { [sorts[index - 1], sorts[index]] = [sorts[index]!, sorts[index - 1]!]; changed(); paintSorts(); } }),
        button('Remove sort', () => { sorts.splice(index, 1); changed(); paintSorts(); })); sortList.append(row);
    });
    sortList.append(button('Add sort', () => { if (properties[0]) sorts.push({ property: properties[0].id, direction: 'ascending' }); changed(); paintSorts(); }));
  }
  function paintGroup() {
    groups.replaceChildren(el('h4', '', 'Shared grouping'));
    const supported = properties.filter(p => ['title', 'rich_text', 'url', 'email', 'phone_number', 'number', 'checkbox', 'select', 'multi_select', 'status', 'people', 'relation', 'date', 'created_time', 'last_edited_time', 'created_by', 'last_edited_by'].includes(p.type));
    groups.append(select('Group by', [['', 'No grouping'], ...supported.map(p => [p.id, p.name] as [string, string])], grouping?.property_id ?? '', id => {
      const p = property(id); if (!p) grouping = null;
      else { const type = p.type === 'rich_text' ? 'text' : p.type === 'people' ? 'person' : p.type; grouping = { type, property_id: id, sort: { type: 'ascending' }, ...(type === 'status' ? { group_by: 'option' } : ['title', 'text', 'url', 'email', 'phone_number'].includes(type) ? { group_by: 'exact' } : ['date', 'created_time', 'last_edited_time'].includes(type) ? { group_by: 'month' } : {}) }; }
      changed(); paintGroup();
    }));
    if (!grouping) return;
    const group = grouping;
    groups.append(select('Group order', [['manual', 'Notion order'], ['ascending', 'Ascending'], ['descending', 'Descending']], group.sort?.type ?? 'manual', type => { group.sort = { ...group.sort, type }; changed(); }));
    const modes = group.type === 'status' ? ['option', 'group'] : ['title', 'text', 'url', 'email', 'phone_number'].includes(group.type) ? ['exact', 'alphabet_prefix'] : ['date', 'created_time', 'last_edited_time'].includes(group.type) ? ['relative', 'day', 'week', 'month', 'year'] : [];
    if (modes.length) groups.append(select('Grouping method', modes.map(v => [v, v.replaceAll('_', ' ')]), group.group_by, value => { group.group_by = value; changed(); }));
    if (group.type === 'number') for (const key of ['range_start', 'range_end', 'range_size']) groups.append(input(key.replaceAll('_', ' '), String(group[key] ?? ''), 'number', value => { if (value === '') delete group[key]; else group[key] = Number(value); changed(); }));
    groups.append(select('Empty groups', [['true', 'Hide empty groups'], ['false', 'Show empty groups']], String(group.hide_empty_groups ?? false), value => { group.hide_empty_groups = value === 'true'; changed(); }));
  }
  paintFilters(); paintSorts(); paintGroup(); element.append(filters, sortList, groups);
  return { element, value(): Raw {
    const patch: Raw = {};
    if (JSON.stringify(filter) !== JSON.stringify(view.filter ?? null)) {
      const clean = (rule: Raw | null): Raw | null => { if (!rule) return null; const key = Array.isArray(rule.and) ? 'and' : Array.isArray(rule.or) ? 'or' : null; if (!key) return rule; const values = rule[key].map(clean).filter(Boolean); return values.length ? { [key]: values } : null; };
      patch.filter = clean(filter);
    }
    if (JSON.stringify(sorts) !== JSON.stringify(view.sorts ?? [])) patch.sorts = sorts.length ? sorts : null;
    if (JSON.stringify(grouping) !== JSON.stringify(view.configuration?.group_by ?? null)) patch.configuration = { type: 'table', group_by: grouping };
    return patch;
  } };
}
