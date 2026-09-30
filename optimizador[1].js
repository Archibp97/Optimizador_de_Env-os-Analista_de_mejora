// Optimizador de envíos: lógica pura (sin interfaz). Funciona en el navegador y en Node.
(function (root) {
  "use strict";

  var DESC = "coordinadora";
  var HOJAS = {
    Parametros: ["Parametro", "Valor"],
    Transportadoras: ["Transportadora", "Factor_volumetrico_kg_m3", "Pct_manejo"],
    Tarifas: ["Ciudad", "Transportadora", "Tarifa_kg", "Flete_minimo", "Dias_entrega", "Cobertura"],
    Pedidos: ["Pedido", "Ciudad", "Peso_kg", "Largo_m", "Ancho_m", "Alto_m", "Valor_declarado", "Plazo_max_dias"]
  };

  function clave(s) {
    return String(s == null ? "" : s).trim().toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function num(v) {
    if (typeof v === "number") return v;
    if (v == null || v === "") return NaN;
    return Number(String(v).replace(/\s/g, "").replace(",", "."));
  }

  // Lee las filas de cada hoja (objetos con los encabezados como claves) y valida columnas.
  function leerDatos(hojas) {
    var errores = [];
    Object.keys(HOJAS).forEach(function (h) {
      if (!hojas[h]) { errores.push("Falta la hoja \"" + h + "\"."); return; }
      var cols = hojas[h].length ? Object.keys(hojas[h][0]) : [];
      HOJAS[h].forEach(function (c) {
        if (cols.indexOf(c) < 0) errores.push("En la hoja \"" + h + "\" falta la columna \"" + c + "\".");
      });
    });
    if (errores.length) return { errores: errores };

    var par = {};
    hojas.Parametros.forEach(function (r) { par[String(r.Parametro).trim()] = num(r.Valor); });
    var vmin = par.Volumen_minimo_Coordinadora_kg, desc = par.Descuento_Coordinadora;
    if (!(vmin >= 0)) errores.push("Parametros: falta \"Volumen_minimo_Coordinadora_kg\" o no es un número.");
    if (!(desc >= 0 && desc < 1)) errores.push("Parametros: \"Descuento_Coordinadora\" debe estar entre 0 y 1 (por ejemplo 0,20).");
    var plazos = par.Respetar_plazos === undefined || isNaN(par.Respetar_plazos) ? true : par.Respetar_plazos === 1;

    var transp = {};
    hojas.Transportadoras.forEach(function (r) {
      transp[clave(r.Transportadora)] = {
        nombre: String(r.Transportadora).trim(),
        factor: num(r.Factor_volumetrico_kg_m3) || 0,
        manejo: num(r.Pct_manejo) || 0
      };
    });
    if (!Object.keys(transp).some(function (k) { return k === DESC; }))
      errores.push("La hoja Transportadoras debe incluir a Coordinadora.");

    var tarifas = {};
    hojas.Tarifas.forEach(function (r, i) {
      var t = clave(r.Transportadora);
      if (!transp[t]) { errores.push("Tarifas fila " + (i + 2) + ": la transportadora \"" + r.Transportadora + "\" no está en la hoja Transportadoras."); return; }
      tarifas[clave(r.Ciudad) + "|" + t] = {
        tarifa: num(r.Tarifa_kg), fmin: num(r.Flete_minimo) || 0,
        dias: num(r.Dias_entrega), cobertura: num(r.Cobertura) === 1
      };
    });

    var pedidos = [];
    hojas.Pedidos.forEach(function (r, i) {
      if (r.Pedido == null || r.Pedido === "") return;
      var p = {
        pedido: r.Pedido, ciudad: String(r.Ciudad == null ? "" : r.Ciudad).trim(),
        tipo: r.Tipo == null ? "" : r.Tipo,
        peso: num(r.Peso_kg), largo: num(r.Largo_m) || 0, ancho: num(r.Ancho_m) || 0, alto: num(r.Alto_m) || 0,
        valor: num(r.Valor_declarado) || 0, plazo: num(r.Plazo_max_dias)
      };
      if (!(p.peso > 0)) errores.push("Pedidos fila " + (i + 2) + " (" + p.pedido + "): Peso_kg vacío o inválido.");
      pedidos.push(p);
    });
    if (!pedidos.length) errores.push("La hoja Pedidos no tiene pedidos.");
    return { errores: errores, vmin: vmin, desc: desc, plazos: plazos, transp: transp, tarifas: tarifas, pedidos: pedidos };
  }

  // Costo de cada pedido con cada transportadora (igual que la versión en Python).
  function calcularOpciones(d) {
    var nombres = Object.keys(d.transp);
    return d.pedidos.map(function (p) {
      var vol = p.largo * p.ancho * p.alto;
      var ops = {};
      nombres.forEach(function (t) {
        var tf = d.tarifas[clave(p.ciudad) + "|" + t], tr = d.transp[t];
        if (!tf || !(tf.tarifa > 0)) return;
        var pf = Math.max(p.peso, vol * tr.factor);
        var costo = Math.round(Math.max(pf * tf.tarifa, tf.fmin) + p.valor * tr.manejo);
        var permitido = tf.cobertura && (!d.plazos || isNaN(p.plazo) || isNaN(tf.dias) || tf.dias <= p.plazo);
        ops[t] = { costo: costo, pesoFact: pf, dias: tf.dias, permitido: permitido, cubre: tf.cobertura };
      });
      return { p: p, ops: ops };
    });
  }

  // Resuelve el modelo binario de forma exacta: se evalúa z = 0 y z = 1 y se toma el mejor.
  // Con z = 1 el problema es un "knapsack de cobertura" que se resuelve con programación dinámica.
  function optimizar(d) {
    var filas = calcularOpciones(d), n = filas.length, errores = [];
    filas.forEach(function (f) {
      if (!Object.keys(f.ops).some(function (t) { return f.ops[t].permitido; }))
        errores.push("El pedido " + f.p.pedido + " (" + f.p.ciudad + ") no tiene ninguna transportadora con cobertura" + (d.plazos ? " y dentro del plazo." : "."));
    });
    if (errores.length) return { errores: errores };

    function mejor(f, excluir) {
      var b = null;
      Object.keys(f.ops).forEach(function (t) {
        var o = f.ops[t];
        if (!o.permitido || t === excluir) return;
        if (!b || o.costo < f.ops[b].costo) b = t;
      });
      return b;
    }

    // z = 0: cada pedido con la más barata a precio lleno
    var sel0 = filas.map(function (f) { return mejor(f, null); });
    var costo0 = sel0.reduce(function (a, t, i) { return a + filas[i].ops[t].costo; }, 0);
    var sol = { z: 0, sel: sel0, costo: costo0 };

    if (d.desc > 0) {
      var sel1 = new Array(n), base = 0, kg0 = 0, items = [];
      filas.forEach(function (f, i) {
        var oC = f.ops[DESC], cOk = oC && oC.permitido, alt = mejor(f, DESC);
        if (cOk && !alt) { sel1[i] = DESC; base += oC.costo * (1 - d.desc); kg0 += oC.pesoFact; }
        else if (!cOk) { sel1[i] = alt; base += f.ops[alt].costo; }
        else { sel1[i] = alt; base += f.ops[alt].costo; items.push({ i: i, kg: oC.pesoFact, delta: oC.costo * (1 - d.desc) - f.ops[alt].costo }); }
      });
      var falta = Math.max(0, d.vmin - kg0);
      var totalItems = items.reduce(function (a, it) { return a + it.kg; }, 0);
      if (totalItems + 1e-9 >= falta) {
        // escala de kilos para la programación dinámica (hasta 0,01 kg si el tamaño lo permite)
        var escala = 100;
        while (escala > 0.01 && items.length * falta * escala > 4e6) escala /= 2;
        var cap = Math.ceil(falta * escala - 1e-9);
        var dp = new Float64Array(cap + 1).fill(Infinity); dp[0] = 0;
        var tomo = [], desde = [];
        items.forEach(function (it) {
          var w = Math.floor(it.kg * escala + 1e-9), nd = dp.slice();
          var tk = new Uint8Array(cap + 1), fr = new Int32Array(cap + 1);
          for (var k = 0; k <= cap; k++) {
            if (dp[k] === Infinity) continue;
            var nk = Math.min(cap, k + w), v = dp[k] + it.delta;
            if (v < nd[nk] - 1e-9) { nd[nk] = v; tk[nk] = 1; fr[nk] = k; }
          }
          tomo.push(tk); desde.push(fr); dp = nd;
        });
        if (dp[cap] < Infinity) {
          var costo1 = base + dp[cap];
          var k = cap;
          for (var j = items.length - 1; j >= 0; j--) {
            if (tomo[j][k]) { sel1[items[j].i] = DESC; k = desde[j][k]; }
          }
          // Ajuste final: pedidos que convienen por Coordinadora aunque ya se cumplió el mínimo
          items.forEach(function (it) {
            if (sel1[it.i] !== DESC && it.delta < 0) { sel1[it.i] = DESC; costo1 += it.delta; }
          });
          if (costo1 < costo0 - 1e-6) sol = { z: 1, sel: sel1, costo: costo1 };
        }
      }
    }

    // Construir resultados
    var asignacion = filas.map(function (f, i) {
      var t = sol.sel[i], o = f.ops[t], descAplic = (sol.z && t === DESC) ? o.costo * d.desc : 0;
      return {
        Pedido: f.p.pedido, Ciudad: f.p.ciudad, Tipo: f.p.tipo, Peso_kg: f.p.peso,
        Peso_facturable: Math.round(o.pesoFact * 10) / 10, Valor_declarado: f.p.valor, Plazo_max_dias: f.p.plazo,
        Transportadora: d.transp[t].nombre, Dias_entrega: o.dias, Costo_tarifa: o.costo,
        Descuento: Math.round(descAplic), Costo_final: Math.round(o.costo - descAplic),
        Mas_barata_individual: d.transp[sel0[i]].nombre, Costo_mas_barata: f.ops[sel0[i]].costo,
        Movido: t !== sel0[i]
      };
    });
    var resumen = Object.keys(d.transp).map(function (t) {
      var r = asignacion.filter(function (a) { return clave(a.Transportadora) === t; });
      return {
        Transportadora: d.transp[t].nombre, Pedidos: r.length,
        Kg_facturables: Math.round(r.reduce(function (a, x) { return a + x.Peso_facturable; }, 0)),
        Costo_tarifa: r.reduce(function (a, x) { return a + x.Costo_tarifa; }, 0),
        Descuento: r.reduce(function (a, x) { return a + x.Descuento; }, 0),
        Costo_final: r.reduce(function (a, x) { return a + x.Costo_final; }, 0)
      };
    });
    var escenarios = [
      { Escenario: "Óptimo (modelo con descuento)", Costo_total: Math.round(sol.costo) },
      { Escenario: "Más barata por pedido, sin buscar descuento", Costo_total: Math.round(costo0) }
    ];
    Object.keys(d.transp).forEach(function (t) {
      var ok = filas.every(function (f) { return f.ops[t] && f.ops[t].cubre; });
      if (!ok) return;
      var tot = filas.reduce(function (a, f) { return a + f.ops[t].costo; }, 0);
      var kg = filas.reduce(function (a, f) { return a + f.ops[t].pesoFact; }, 0);
      if (t === DESC && kg >= d.vmin) tot *= (1 - d.desc);
      escenarios.push({ Escenario: "Todo con " + d.transp[t].nombre, Costo_total: Math.round(tot) });
    });
    escenarios.forEach(function (e) { e.Diferencia_vs_optimo = e.Costo_total - Math.round(sol.costo); });

    var kgC = asignacion.filter(function (a) { return clave(a.Transportadora) === DESC; })
      .reduce(function (a, x) { return a + x.Peso_facturable; }, 0);
    return {
      errores: [], descuentoActivo: sol.z === 1, costoOptimo: Math.round(sol.costo), costoSinDescuento: Math.round(costo0),
      kgCoordinadora: kgC, vmin: d.vmin, desc: d.desc, asignacion: asignacion, resumen: resumen, escenarios: escenarios
    };
  }

  var api = { leerDatos: leerDatos, optimizar: optimizar, HOJAS: HOJAS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Optimizador = api;
})(this);
