import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import axios from "axios";
import dotenv from "dotenv";
import { Expo } from "expo-server-sdk";
import { createClient } from '@supabase/supabase-js';
import { Resend } from "resend";





dotenv.config();
export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
);
const resend = new Resend(process.env.API_SEND_EMAILS);
// Guardar temporalmente los códigos de recuperación
const codigosReset = new Map();


const expo = new Expo();


interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}


// Configuración mejorada de conexión PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});


// Verificación mejorada de conexión
pool.connect()
.then(() => console.log("✅ Conexión exitosa a Supabase"))
.catch((err) => console.error("❌ Error al conectar a Supabase:", err));


const app = express();
const PORT = process.env.PORT || 3000;

// Configuración mejorada de CORS y middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para manejo de errores global
app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error('⚠️ Error global:', err.stack);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Validación de campos comunes
const validarCamposUsuario = (req: Request, res: Response, next: Function) => {
  const { nombre, correo, contraseña, telefono } = req.body;
  
  if (!nombre || !correo || !contraseña || !telefono) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  
  if (telefono.length !== 10 || !/^\d+$/.test(telefono)) {
    return res.status(400).json({ error: 'Teléfono debe tener 10 dígitos' });
  }
  
  next();
};

// Ruta para registrar usuario con foto en Supabase
app.post('/registrar', validarCamposUsuario, async (req: Request, res: Response) => {
  const { nombre, correo, contraseña, telefono, foto } = req.body;

  const client = await pool.connect();

  try {
    // Verificar si el usuario ya existe
    const usuarioExistente = await pool.query(
      'SELECT 1 FROM usuario WHERE correo = $1',
      [correo]
    );

    if (usuarioExistente.rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    await client.query('BEGIN');

    let publicUrl: string | null = null;

    if (foto) {
      // Detectar tipo real de imagen
      const match = foto.match(/^data:image\/(\w+);base64,/);
      if (!match) {
        return res.status(400).json({ error: 'Formato de imagen inválido' });
      }
      const tipo = match[1]; // 'png', 'jpeg', etc.

      // Convertir base64 a buffer
      const base64Data = foto.replace(/^data:image\/\w+;base64,/, "");
      const fotoBuffer = Buffer.from(base64Data, 'base64');

      // Generar nombre único para la foto
      const nombreArchivo = `publicaciones/${correo}_${Date.now()}.${tipo}`;

      // Subir foto al bucket 'articulos' (igual que publicar_articulo)
      const { error: uploadError } = await supabase.storage
        .from('articulos')
        .upload(nombreArchivo, fotoBuffer, {
          contentType: `image/${tipo}`,
          upsert: true,
        });

      if (uploadError) {
        console.error('Error al subir la foto:', uploadError);
        return res.status(500).json({ error: 'No se pudo subir la foto' });
      }

      // Obtener URL pública
      const { data } = supabase.storage.from('articulos').getPublicUrl(nombreArchivo);
      publicUrl = data.publicUrl;
    }

    // Insertar usuario en la base de datos con URL pública de la foto
    const result = await client.query(
      'INSERT INTO usuario (nombre, correo, contraseña, telefono, foto) VALUES ($1, $2, $3, $4, $5) RETURNING id_usuario, nombre, correo, foto',
      [nombre, correo, contraseña, telefono, publicUrl]
    );

    await client.query('COMMIT');

    res.status(201).json({ 
      mensaje: 'Usuario registrado correctamente',
      usuario: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  } finally {
    client.release();
  }
});



// Ruta para iniciar sesión - Mejorada
app.post('/iniciar-sesion', async (req: Request, res: Response) => {
  try {
    const { correo, contraseña } = req.body;
    
    if (!correo || !contraseña) {
      return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
    }

    const result = await pool.query(
      `SELECT id_usuario AS "ID_usuario", nombre, correo 
       FROM usuario 
       WHERE correo = $1 AND contraseña = $2`,
      [correo, contraseña]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    res.status(200).json({ 
      mensaje: 'Inicio de sesión exitoso',
      usuario: result.rows[0] 
    });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});



//prueba de restablecimiento de contraseña
app.post("/enviar-correo-reset", async (req, res) => {
  const { correo } = req.body;
  try {
    const result = await pool.query("SELECT * FROM usuario WHERE correo = $1", [correo]);
    if (result.rows.length === 0) {
      return res.status(404).json({ mensaje: "Correo no registrado" });
    }

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    codigosReset.set(correo, codigo);

    // enviar email usando Resend
    await resend.emails.send({
      from: "Soporte Ruedas <onboarding@resend.dev>", // puedes usar este temporalmente
      to: correo,
      subject: "Código para restablecer contraseña",
      text: `Tu código es: ${codigo}`,
    });

    res.json({ mensaje: "Código enviado al correo" });
  } catch (error) {
    console.error("❌ Error enviando correo:", error);
    res.status(500).json({ mensaje: "Error del servidor" });
  }
});

//restablecer contraseña
app.post("/restablecer-contrasena", async (req, res) => {
  const { correo, codigo, nuevaContraseña } = req.body;
  const codigoGuardado = codigosReset.get(correo);

  if (!codigoGuardado || codigoGuardado !== codigo) {
    return res.status(400).json({ mensaje: "Código incorrecto o expirado" });
  }

  try {
    await pool.query('UPDATE usuario SET "contraseña" = $1 WHERE correo = $2', [nuevaContraseña, correo]);
    codigosReset.delete(correo);

    res.json({ mensaje: "Contraseña actualizada correctamente" });
  } catch (error) {
    console.error("❌ Error actualizando contraseña:", error);
    res.status(500).json({ mensaje: "Error del servidor" });
  }
});


//buscar 
// 🔍 Buscar publicaciones por nombre
app.get('/buscar', async (req: Request, res: Response) => {
  const nombre = req.query.nombre as string;

  if (!nombre || nombre.trim() === '') {
    return res.status(400).json({ error: 'El parámetro "nombre" es obligatorio' });
  }

  try {
    const resultado = await pool.query(
      `SELECT 
        cv.ID_publicacion as id,
        cv.nombre_articulo, 
        cv.descripcion, 
        cv.precio, 
        cv.tipo_bicicleta, 
        cv.tipo_componente,
        cv.ID_usuario AS id_vendedor,
        u.nombre AS nombre_vendedor,
        u.telefono,
        u.foto,
        COALESCE(
          json_agg(cvf.url_foto) FILTER (WHERE cvf.url_foto IS NOT NULL),
          '[]'
        ) as fotos
      FROM com_ventas cv
      INNER JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos cvf ON cv.ID_publicacion = cvf.ID_publicacion
      WHERE cv.nombre_articulo ILIKE $1
      GROUP BY 
        cv.ID_publicacion, 
        cv.nombre_articulo, 
        cv.descripcion, 
        cv.precio, 
        cv.tipo_bicicleta, 
        cv.tipo_componente,
        cv.ID_usuario,
        u.nombre, 
        u.telefono,
        u.foto`,
      [`%${nombre}%`]
    );

    res.status(200).json(resultado.rows);
  } catch (error) {
    console.error('❌ Error al buscar artículos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});




// Ruta para publicar artículo con fotos en Supabase
app.post('/publicar_articulo', async (req: Request, res: Response) => {
  const { nombre_Articulo, descripcion, precio, tipo_bicicleta, tipo_componente, fotos, ID_usuario } = req.body;

  if (!ID_usuario) return res.status(400).json({ error: 'ID de usuario es requerido' });
  if (!fotos || !Array.isArray(fotos) || fotos.length === 0) return res.status(400).json({ error: 'Se requiere al menos una foto' });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO com_ventas 
        (nombre_Articulo, descripcion, precio, tipo_bicicleta, tipo_componente, ID_usuario) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING ID_publicacion`,
      [nombre_Articulo, descripcion, precio, tipo_bicicleta, tipo_componente, ID_usuario]
    );

    const idPublicacion = result.rows[0].id_publicacion;

    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];

      // Detectar tipo real de imagen
      const match = foto.match(/^data:image\/(\w+);base64,/);
      if (!match) throw new Error('Formato de imagen inválido');
      const tipo = match[1]; // 'png', 'jpeg', etc.

      // Convertir base64 a buffer
      const base64Data = foto.replace(/^data:image\/\w+;base64,/, "");
      const fotoBuffer = Buffer.from(base64Data, 'base64');

      const nombreArchivo = `publicaciones/${idPublicacion}/foto_${i}.${tipo}`;

      // Subir al bucket
      const { error: uploadError } = await supabase.storage
        .from('articulos')
        .upload(nombreArchivo, fotoBuffer, { contentType: `image/${tipo}`, upsert: true });

      if (uploadError) throw uploadError;

      // Obtener URL pública
      const { data } = supabase.storage.from('articulos').getPublicUrl(nombreArchivo);
      const publicUrl = data.publicUrl;

      // Guardar URL en la base de datos
      await client.query(
        `INSERT INTO com_ventas_fotos (ID_publicacion, url_foto) VALUES ($1, $2)`,
        [idPublicacion, publicUrl]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Artículo publicado con éxito', ID_publicacion: idPublicacion });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al publicar artículo:', error);
    res.status(500).json({ error: 'Error al publicar el artículo' });
  } finally {
    client.release();
  }
});


//prueba de notificacion en apk 


app.post("/guardar-token", async (req: Request, res: Response) => {
  try {
    const { ID_usuario, token } = req.body;

    if (!ID_usuario || !token) {
      return res.status(400).json({ error: "Faltan ID_usuario o token" });
    }

    if (!Expo.isExpoPushToken(token)) {
      return res.status(400).json({ error: "Token inválido" });
    }

    await pool.query(
      `INSERT INTO user_tokens (ID_usuario, token)
       VALUES ($1, $2)
       ON CONFLICT (ID_usuario, token) DO NOTHING`,
      [ID_usuario, token]
    );

    res.json({ ok: true, message: "Token guardado" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error guardando token" });
  }
});


// Guardar notificación en BD
app.post("/notificaciones/guardar-notificacion", async (req: Request, res: Response) => {
  try {
    const { id_usuario, titulo, cuerpo } = req.body;
    await pool.query(
      `INSERT INTO notificaciones (id_usuario, titulo, cuerpo) VALUES ($1, $2, $3)`,
      [id_usuario, titulo, cuerpo]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error guardando notificación" });
  }
});

// Función para enviar notificación push y guardar en BD

async function enviarNotificacion(
  tokens: string[],
  titulo: string,
  cuerpo: string,
  usuarios: number[]
) {
  // Enviar push
  const mensajes = tokens.map(token => ({
    to: token,
    sound: "default",
    title: titulo,
    body: cuerpo,
  }));

  const chunks = expo.chunkPushNotifications(mensajes);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      console.log("🎫 Tickets enviados:", tickets);
    } catch (err) {
      console.error("❌ Error enviando push:", err);
    }
  }

  // Guardar en BD
  for (const id_usuario of usuarios) {
    try {
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, titulo, cuerpo) VALUES ($1, $2, $3)`,
        [id_usuario, titulo, cuerpo]
      );
    } catch (err) {
      console.error("❌ Error guardando notificación en BD para usuario", id_usuario, err);
    }
  }
}



// Ruta para agregar al carrito - Mejorada
app.post('/agregar-carrito', async (req: Request, res: Response) => {
  try {
    const { ID_usuario, ID_publicacion } = req.body;
    console.log('ID_usuario recibido:', ID_usuario);
    console.log('ID_publicacion recibido:', ID_publicacion);

    if (!ID_usuario || !ID_publicacion) {
      return res.status(400).json({ error: 'IDs de usuario y publicación son obligatorios' });
    }

    // Verificar existencia
    const verificacion = await pool.query(
      `SELECT 
        (SELECT 1 FROM usuario WHERE ID_usuario = $1) AS usuario_existe,
        (SELECT 1 FROM com_ventas WHERE ID_publicacion = $2) AS articulo_existe,
        (SELECT 1 FROM carrito WHERE ID_usuario = $1 AND ID_publicacion = $2) AS en_carrito`,
      [ID_usuario, ID_publicacion]
    );

    const { usuario_existe, articulo_existe, en_carrito } = verificacion.rows[0];

    if (!usuario_existe) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!articulo_existe) return res.status(404).json({ error: 'Artículo no encontrado' });
    if (en_carrito) return res.status(409).json({ error: 'Artículo ya está en el carrito' });

    // Insertar en carrito
    await pool.query(
      'INSERT INTO carrito (ID_usuario, ID_publicacion) VALUES ($1, $2)',
      [ID_usuario, ID_publicacion]
    );

    // Obtener datos del vendedor
    const datosVendedor = await pool.query(
      `SELECT u.ID_usuario, u.nombre
       FROM com_ventas cv
       JOIN usuario u ON cv.ID_usuario = u.ID_usuario
       WHERE cv.ID_publicacion = $1`,
      [ID_publicacion]
    );

    const vendedor = datosVendedor.rows[0];
    if (vendedor) {
      const tokensRes = await pool.query("SELECT token FROM user_tokens WHERE ID_usuario = $1", [vendedor.ID_usuario]);
      const tokens = tokensRes.rows.map(r => r.token);
      if (tokens.length > 0) {
        await enviarNotificacion(
          tokens,
          "¡Nuevo interés en tu artículo!",
          "Un usuario agregó tu artículo al carrito 🚀",
          [vendedor.ID_usuario]
        );
      }
    } 

    res.status(201).json({ mensaje: 'Artículo agregado al carrito correctamente' });
  } catch (error) {
    console.error('Error al agregar al carrito:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});




// Endpoint para obtener los artículos del carrito de un usuario
app.get('/carrito/:id_usuario', async (req: Request, res: Response) => {
  try {
    const { id_usuario } = req.params;
    if (!id_usuario || isNaN(Number(id_usuario))) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const result = await pool.query(
      `SELECT 
        cv.ID_publicacion as id,
        cv.nombre_Articulo,
        cv.descripcion,
        cv.precio,
        cv.tipo_bicicleta,
        u.nombre as nombre_vendedor,
        u.telefono,
        u.foto,
        cv.ID_usuario as id_vendedor,
        COALESCE(json_agg(f.url_foto) FILTER (WHERE f.url_foto IS NOT NULL), '[]') as fotos
      FROM carrito c
      JOIN com_ventas cv ON c.ID_publicacion = cv.ID_publicacion 
      JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos f ON cv.ID_publicacion = f.ID_publicacion
      WHERE c.ID_usuario = $1
      GROUP BY cv.ID_publicacion, u.nombre, u.telefono, u.foto, cv.ID_usuario`,
      [id_usuario]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener carrito:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Endpoint para eliminar un artículo del carrito
app.delete('/eliminar-carrito', async (req: Request, res: Response) => {
  console.log('🗑️ Solicitud DELETE recibida en /eliminar-carrito');
  console.log('Body recibido:', req.body);
  
  try {
    const { ID_usuario, ID_publicacion } = req.body;
    
    // Validación de campos
    if (!ID_usuario || !ID_publicacion) {
      console.error('❌ Faltan campos requeridos');
      return res.status(400).json({ 
        error: 'IDs de usuario y publicación son obligatorios',
        received: req.body
      });
    }
    
    // Verificar existencia antes de eliminar
    const existe = await pool.query(
      'SELECT 1 FROM carrito WHERE ID_usuario = $1 AND ID_publicacion = $2',
      [ID_usuario, ID_publicacion]
    );
    
    if (existe.rows.length === 0) {
      console.error('❌ Artículo no encontrado en carrito');
      return res.status(404).json({ 
        error: 'Artículo no encontrado en el carrito',
        details: `Usuario: ${ID_usuario}, Artículo: ${ID_publicacion}`
      });
    }
    
    // Eliminar el artículo
    const result = await pool.query(
      'DELETE FROM carrito WHERE ID_usuario = $1 AND ID_publicacion = $2 RETURNING *',
      [ID_usuario, ID_publicacion]
    );
    
    console.log(`✅ Artículo eliminado:`, result.rows[0]);
    
    res.status(200).json({ 
      success: true,
      mensaje: 'Artículo eliminado del carrito',
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('❌ Error en DELETE /eliminar-carrito:', error);
    res.status(500).json({ 
      error: 'Error al eliminar del carrito',
      
    });
  }
});

//Iniciar sesion como administrador
app.post('/iniciar-administrador', async (req: Request, res: Response) =>{
  try{
    const {usuario, contraseña, contraseña2} = req.body;
    if( !usuario || !contraseña || !contraseña2){
      return res.status(400).json({error: 'usuario y contraseñas son obligatorios'});
    }
    const result = await pool.query(
      //constulta sql
      `SELECT usuario, contraseña, contraseña2 
      FROM usuarioadmin
      WHERE usuario = $1 AND contraseña = $2 AND contraseña2 =$3`,
    [usuario, contraseña, contraseña2]
    ); 
    if(result.rows.length === 0) {
      return res.status(401).json({error: 'Credenciales incorrectas'})
    }
    res.status(200).json({
      mensaje: 'Inicio de sesion exitoso',
      usuario: result.rows[0]
    })
  }catch (error){
    console.error('Error al iniciar sesion', error)
    res.status(500).json({error: 'usuario y contraseña con obligatorios'})
  }
})

//obtener usuarios - administrador
app.get('/obtener-usuarios', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
      ID_usuario as id_usuario,
      nombre,
      correo,
      telefono,
      foto
      FROM usuario 
      `);
      console.log('Usuarios obtenidos:', result.rows.length);
      res.status(200).json(result.rows); // ✔️ Devuelve JSON
    } catch (error) {
      console.error('Error al obtener usuarios:', error);
      res.status(500).json({ error: 'Error en el servidor' }); // ✔️ Siempre devuelve JSON
  }
});
// administrar publicaciones - administrador con múltiples fotos
app.get('/obtener-publicaciones/:ID_usuario', async (req, res) => {
  try {
    const { ID_usuario } = req.params;

    const result = await pool.query(`
      SELECT 
        cv.ID_publicacion AS id,
        cv.nombre_Articulo,
        cv.descripcion,
        cv.precio,
        cv.tipo_bicicleta,
        COALESCE(array_agg(cf.url_foto) FILTER (WHERE cf.url_foto IS NOT NULL), ARRAY[]::text[]) AS fotos, 
        u.nombre AS nombre_vendedor,
        u.foto
      FROM com_ventas cv
      JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos cf ON cv.ID_publicacion = cf.ID_publicacion
      WHERE cv.ID_usuario = $1
      GROUP BY cv.ID_publicacion, u.nombre, u.foto
      ORDER BY cv.ID_publicacion DESC;
    `, [ID_usuario]);

    console.log('Publicaciones obtenidas:', result.rows.length);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Error al obtener publicaciones:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

  //eliminar usuario - administrador
  app.delete('/eliminar-usuario/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM usuario WHERE ID_usuario = $1 RETURNING *', [id]);
      res.status(200).json({ message: "Usuario eliminado correctamente" });
    } catch (error) {
      console.error("Error al eliminar usuario:", error);
      res.status(500).json({ error: "Error al eliminar usuario" });
    }
  });

  //eliminar publicacion - administrador

  app.delete('/eliminar-publicaciones-admin/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        'DELETE FROM com_ventas WHERE ID_publicacion = $1 RETURNING *',
        [id]
      );
      
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Publicación no encontrada' });
      }
      
      console.log('Se eliminó la publicación', result.rows[0]);
      res.json({ message: 'Publicación eliminada con éxito', deleted: result.rows[0] });
    } catch (error) {
      console.error('Error al eliminar publicación:', error);
      res.status(500).json({ error: 'Error en el servidor' });
    }
  });


// publicaciones del usuario logueado
app.get('/obtener-publicaciones-usuario-logueado/:ID_usuario', async (req, res) => {
  try {
    const { ID_usuario } = req.params;

    const result = await pool.query(
      `
      SELECT 
        cv.ID_publicacion AS id,
        cv.nombre_Articulo,
        cv.descripcion,
        cv.precio,
        cv.tipo_bicicleta,
        COALESCE(
          json_agg(cvf.url_foto) FILTER (WHERE cvf.url_foto IS NOT NULL),
          '[]'
        ) AS fotos
      FROM com_ventas cv
      JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos cvf ON cv.ID_publicacion = cvf.ID_publicacion
      WHERE cv.ID_usuario = $1
      GROUP BY cv.ID_publicacion, cv.nombre_Articulo, cv.descripcion, cv.precio, cv.tipo_bicicleta
      ORDER BY cv.ID_publicacion DESC;
      `,
      [ID_usuario]
    );

    console.log('Publicaciones obtenidas:', result.rows.length);
    res.status(200).json(result.rows);

  } catch (error) {
    console.error('Error al obtener publicaciones:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

  
  //marcar como vendido
app.delete('/marcar-vendido/:id', async (req, res) => {
  const idPublicacion = Number(req.params.id);
  try {
  
    const pubRes = await pool.query('SELECT * FROM com_ventas WHERE ID_publicacion = $1', [idPublicacion]);
    if (pubRes.rowCount === 0) return res.status(404).json({ error: 'Publicación no encontrada' });
    const publicacion = pubRes.rows[0];

    const nombreArticulo = publicacion.nombre_articulo ?? publicacion.nombre_Articulo ?? publicacion.nombre_Articulo ?? 'Artículo';

   
    const compradoresRes = await pool.query(
      `SELECT c.ID_usuario AS id_usuario, u.nombre
       FROM carrito c
       JOIN usuario u ON c.ID_usuario = u.ID_usuario
       WHERE c.ID_publicacion = $1`,
      [idPublicacion]
    );
    console.log('👥 Compradores encontrados:', compradoresRes.rows);

    // 2) obtener tokens de esos compradores
   const compradoresIds = compradoresRes.rows.map(r => r.ID_usuario);
    const tokensRes = await pool.query(
      `SELECT ID_usuario, token FROM user_tokens WHERE ID_usuario = ANY($1::int[])`,
      [compradoresIds]
    );
    const tokens = tokensRes.rows.map(r => r.token);

    // 3) borrar publicación y limpiar carrito dentro de transacción (consistencia)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const delPub = await client.query('DELETE FROM com_ventas WHERE ID_publicacion = $1 RETURNING *', [idPublicacion]);
      await client.query('DELETE FROM carrito WHERE ID_publicacion = $1', [idPublicacion]);
      await client.query('COMMIT');
      console.log('🗑️ Publicación y carrito eliminados en BD');
    } catch (txErr) {
      await client.query('ROLLBACK');
      client.release();
      console.error('❌ Error en transacción:', txErr);
      return res.status(500).json({ error: 'Error en transacción al eliminar publicación' });
    }
    client.release();

    // 4) enviar notificaciones a cada token usando el mismo endpoint que ya FUNCIONA (axios -> exp.host)
   if (tokens.length > 0) {
      await enviarNotificacion(
        tokens,
        'Artículo ya no disponible ❌',
        `El artículo "${nombreArticulo}" que tenías en tu carrito ya fue vendido.`,
        compradoresIds
      );
    }

    res.json({ message: 'Publicación eliminada y compradores notificados' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
   
});



  
  
 // Ruta para el chat
app.post("/chat", async (req: Request, res: Response) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "El campo 'message' es requerido" });
  }

  try {
    const response = await axios.post<OpenAIChatResponse>(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: message }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    const reply = response.data.choices[0].message.content;
    res.json({ reply });
  } catch (error: any) {
    console.error("Error al llamar a OpenAI:", error.response?.data || error);
    res.status(500).json({ error: "Error interno al conectar con OpenAI" });
  }
});

// Publicaciones disponibles filtradas por bicicleta y tipo
app.get("/publicaciones", async (req: Request, res: Response) => {
  const { tipo, componente } = req.query;

  if (!tipo || !componente) {
    return res.status(400).json({ error: "Faltan parámetros: tipo y componente" });
  }

  try {
    const result = await pool.query(
      `SELECT 
        cv.ID_publicacion AS id,
        cv.nombre_Articulo AS nombre_articulo,
        cv.descripcion,
        cv.precio,
        cv.tipo_bicicleta,
        cv.tipo_componente,
        cv.ID_usuario AS id_vendedor,
        u.nombre AS nombre_vendedor,
        u.telefono,
        u.foto,
        -- Todas las fotos
        COALESCE(
          json_agg(cvf.url_foto) FILTER (WHERE cvf.url_foto IS NOT NULL), '[]'
        ) AS fotos,
        -- Primera foto (para compatibilidad con tu frontend actual)
        COALESCE(
          (ARRAY_AGG(cvf.url_foto ORDER BY cvf.id_foto ASC))[1], NULL
        )
      FROM com_ventas cv
      JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos cvf ON cv.ID_publicacion = cvf.ID_publicacion
      WHERE LOWER(cv.tipo_bicicleta) = LOWER($1)
        AND LOWER(cv.tipo_componente) = LOWER($2)
      GROUP BY cv.ID_publicacion, u.nombre, u.telefono, u.foto, cv.nombre_Articulo, cv.descripcion, cv.precio, cv.tipo_bicicleta,cv.ID_usuario, cv.tipo_componente
      ORDER BY cv.ID_publicacion DESC`,
      [tipo, componente]
    );

    res.json(result.rows);
  } catch (error: any) {
    console.error("❌ Error al obtener publicaciones:", error.message);
    res.status(500).json({ error: error.message });
  }
});


//informacion del usuario
app.get("/usuario/:id", async (req, res) => {
  const { id } = req.params;
  const result = await pool.query("SELECT * FROM usuario WHERE ID_usuario = $1", [id]);
  if (result.rows.length === 0) {
    return res.status(404).json({ error: "Usuario no encontrado" });
  }
  res.json(result.rows[0]);
});

//editar informacion del usuario
app.put("/EditarUsuario/:id", async (req, res) => {
  const { id } = req.params;
  const { nombre, correo, telefono } = req.body;

  try {
    const result = await pool.query(
      "UPDATE usuario SET nombre=$1, correo=$2, telefono=$3 WHERE ID_usuario=$4 RETURNING *",
      [nombre, correo, telefono, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al actualizar usuario" });
  }
});

//cambiar contraseña
app.put("/CambiarContrasena/:id", async (req, res) => {
  const { id } = req.params;
  const { passwordActual, passwordNueva } = req.body;

  try {
    // Verificar contraseña actual
    const result = await pool.query("SELECT contraseña FROM usuario WHERE ID_usuario=$1", [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

    const contraseñaGuardada = result.rows[0].contraseña;



    if (passwordActual !== contraseñaGuardada) {
      return res.status(400).json({ error: "Contraseña actual incorrecta" });
    }

    // Actualizar con nueva contraseña
    await pool.query("UPDATE usuario SET contraseña=$1 WHERE ID_usuario=$2", [passwordNueva, id]);

    res.json({ message: "Contraseña actualizada correctamente" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error al cambiar la contraseña" });
  }
});




// Endpoint para obtener los artículos relacionados al vendedor
app.get('/PublicacionesRelacionadasVendedor/:id_usuario', async (req: Request, res: Response) => {
  try {
    const { id_usuario } = req.params;
    if (!id_usuario || isNaN(Number(id_usuario))) {
      return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    const result = await pool.query(
      `SELECT 
        cv.ID_publicacion as id,
        cv.nombre_Articulo,
        cv.descripcion,
        cv.precio,
        cv.tipo_bicicleta,
        u.nombre as nombre_vendedor,
        u.telefono,
        u.foto,
        cv.ID_usuario as id_vendedor,
        COALESCE(json_agg(f.url_foto) FILTER (WHERE f.url_foto IS NOT NULL), '[]') as fotos
      FROM carrito c
      JOIN com_ventas cv ON c.ID_publicacion = cv.ID_publicacion 
      JOIN usuario u ON cv.ID_usuario = u.ID_usuario
      LEFT JOIN com_ventas_fotos f ON cv.ID_publicacion = f.ID_publicacion
      WHERE c.ID_usuario = $1
      GROUP BY cv.ID_publicacion, u.nombre, u.telefono, u.foto, cv.ID_usuario`,
      [id_usuario]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Error al obtener publicaciones del vendedor:', error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});


// Iniciar servidor con manejo de errores
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
}).on('error', (err) => {
  console.error('❌ Error al iniciar el servidor:', err.message);
  process.exit(1);
});


// Manejo de cierre limpio
process.on('SIGTERM', () => {
  console.log('🛑 Recibida señal SIGTERM. Cerrando servidor...');
  pool.end().then(() => {
    console.log('✅ Conexión a PostgreSQL cerrada');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('🛑 Recibida señal SIGINT. Cerrando servidor...');
  pool.end().then(() => {
    console.log('✅ Conexión a PostgreSQL cerrada');
    process.exit(0);
  });
});

