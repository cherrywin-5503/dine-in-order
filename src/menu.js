// menu 模块：分类、菜品、规格（设计文档 3.2）
const { ApiError } = require('./errors');
const { tx } = require('./db');

function create(db, clock) {
  // 把一个菜品的规格行整理成分组
  function groupSpecs(rows) {
    const groups = [];
    for (const r of rows) {
      let g = groups.find((x) => x.group_name === r.group_name);
      if (!g) groups.push((g = { group_name: r.group_name, options: [] }));
      g.options.push({ id: r.id, option_name: r.option_name, price_delta_fen: r.price_delta_fen, is_default: !!r.is_default });
    }
    return groups;
  }

  function listDishes({ includeOffSale }) {
    const dishes = db.prepare(
      `SELECT d.*, c.name AS category_name FROM dish d JOIN category c ON c.id=d.category_id
       ${includeOffSale ? '' : 'WHERE d.on_sale=1'} ORDER BY c.sort_no, c.id, d.id`
    ).all();
    const specs = db.prepare('SELECT * FROM dish_spec ORDER BY id').all();
    return dishes.map((d) => ({
      id: d.id, category_id: d.category_id, category_name: d.category_name, name: d.name,
      image_url: d.image_url, price_fen: d.price_fen, on_sale: !!d.on_sale, sold_out: !!d.sold_out,
      spec_groups: groupSpecs(specs.filter((s) => s.dish_id === d.id)),
    }));
  }

  return {
    listCategories() {
      return db.prepare('SELECT id,name,sort_no FROM category ORDER BY sort_no,id').all();
    },
    // A3：顾客菜单（只有上架的菜品）
    customerMenu() {
      const v = db.prepare('SELECT COALESCE(MAX(updated_at),0) v FROM dish').get().v;
      return { version: v, categories: this.listCategories(), dishes: listDishes({ includeOffSale: false }) };
    },
    allDishes() { return listDishes({ includeOffSale: true }); },

    // MenuService.priceOf：校验菜品并计算单价（分）。售罄或下架抛 40902
    priceOf(dishId, specOptionIds = []) {
      const d = db.prepare('SELECT * FROM dish WHERE id=?').get(dishId);
      if (!d || !d.on_sale || d.sold_out)
        throw new ApiError(40902, `${d ? d.name : '菜品'}已售罄或已下架`, { dish_id: dishId });
      const specs = db.prepare('SELECT * FROM dish_spec WHERE dish_id=? ORDER BY id').all(dishId);
      const picked = new Set(specOptionIds);
      for (const id of picked) if (!specs.some((s) => s.id === id)) throw new ApiError(40001, '规格选项不属于该菜品');
      const chosen = [];
      for (const g of groupSpecs(specs)) {
        const sel = g.options.filter((o) => picked.has(o.id));
        if (sel.length > 1) throw new ApiError(40001, `${g.group_name}只能选一项`);
        // 每组必选一项，没选就用默认项（FR-03）
        chosen.push(sel[0] || g.options.find((o) => o.is_default) || g.options[0]);
      }
      return {
        dish: d,
        unit_price_fen: d.price_fen + chosen.reduce((s, o) => s + o.price_delta_fen, 0),
        spec_text: chosen.map((o) => o.option_name).join('、'),
      };
    },

    // 分类管理（C1）
    saveCategory({ id, name, sort_no }) {
      name = String(name || '').trim();
      if (!name || name.length > 20) throw new ApiError(40001, '分类名称不能为空，最多 20 字');
      sort_no = Number.isInteger(sort_no) ? sort_no : 0;
      try {
        if (id) {
          const r = db.prepare('UPDATE category SET name=?, sort_no=? WHERE id=?').run(name, sort_no, id);
          if (!r.changes) throw new ApiError(40401, '分类不存在');
          return { id };
        }
        return { id: Number(db.prepare('INSERT INTO category(name,sort_no) VALUES (?,?)').run(name, sort_no).lastInsertRowid) };
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (/UNIQUE/.test(e.message)) throw new ApiError(40001, '分类名称已存在');
        throw e;
      }
    },

    // 菜品新增/编辑（C2）：改价只更新 dish 表，历史订单用的是下单时的价格快照（FR-16）
    saveDish(body, id) {
      const name = String(body.name || '').trim();
      if (!name || name.length > 30) throw new ApiError(40001, '菜名不能为空，最多 30 字');
      if (!Number.isInteger(body.price_fen) || body.price_fen <= 0) throw new ApiError(40001, '价格必须是大于 0 的整数（分）');
      if (!db.prepare('SELECT 1 FROM category WHERE id=?').get(body.category_id)) throw new ApiError(40001, '分类不存在');
      const groups = Array.isArray(body.spec_groups) ? body.spec_groups : [];
      for (const g of groups) {
        const gn = String(g.group_name || '').trim();
        if (!gn || !Array.isArray(g.options) || g.options.length === 0) throw new ApiError(40001, '规格组需要名称和至少一个选项');
        if (g.options.filter((o) => o.is_default).length > 1) throw new ApiError(40001, '每组只能有一个默认项');
        for (const o of g.options) {
          if (!String(o.option_name || '').trim()) throw new ApiError(40001, '规格选项名称不能为空');
          if (!Number.isInteger(o.price_delta_fen) || o.price_delta_fen < 0) throw new ApiError(40001, '规格加价不能为负数');
        }
      }
      return tx(db, () => {
        const now = clock.now();
        let dishId = id;
        const onSale = body.on_sale === false ? 0 : 1;
        if (id) {
          const r = db.prepare('UPDATE dish SET category_id=?,name=?,image_url=?,price_fen=?,on_sale=?,updated_at=? WHERE id=?')
            .run(body.category_id, name, body.image_url || null, body.price_fen, onSale, now, id);
          if (!r.changes) throw new ApiError(40401, '菜品不存在');
        } else {
          dishId = Number(db.prepare('INSERT INTO dish(category_id,name,image_url,price_fen,on_sale,updated_at) VALUES (?,?,?,?,?,?)')
            .run(body.category_id, name, body.image_url || null, body.price_fen, onSale, now).lastInsertRowid);
        }
        // 规格：简单起见整组重建（历史订单保存的是 spec_text 文字快照，不受影响）
        db.prepare('DELETE FROM dish_spec WHERE dish_id=?').run(dishId);
        const ins = db.prepare('INSERT INTO dish_spec(dish_id,group_name,option_name,price_delta_fen,is_default) VALUES (?,?,?,?,?)');
        for (const g of groups) {
          const hasDefault = g.options.some((o) => o.is_default);
          g.options.forEach((o, i) => ins.run(dishId, String(g.group_name).trim(), String(o.option_name).trim(),
            o.price_delta_fen, (o.is_default || (!hasDefault && i === 0)) ? 1 : 0));
        }
        return { id: dishId };
      });
    },

    // B3：店员标记售罄/恢复
    setSoldOut(dishId, soldOut) {
      const r = db.prepare('UPDATE dish SET sold_out=?, updated_at=? WHERE id=?').run(soldOut ? 1 : 0, clock.now(), dishId);
      if (!r.changes) throw new ApiError(40401, '菜品不存在');
      return { id: dishId, sold_out: !!soldOut };
    },
  };
}
module.exports = { create };
