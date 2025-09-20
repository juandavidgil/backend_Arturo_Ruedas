import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import axios from "axios";
import dotenv from "dotenv";
import { Expo } from "expo-server-sdk";
import { createClient } from '@supabase/supabase-js';


export const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);


dotenv.config();


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
  ssl: { rejectUnauthorized: false }, // obligatorio para Supabase
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

// Ruta para registrar usuario - Mejorada
app.post('/registrar', validarCamposUsuario, async (req: Request, res: Response) => {
  try {
    const { nombre, correo, contraseña, telefono, foto } = req.body;
    
    const usuarioExistente = await pool.query(
      'SELECT 1 FROM usuario WHERE correo = $1',
      [correo]
    );
    
    if (usuarioExistente.rows.length > 0) {
      return res.status(409).json({ error: 'El correo ya está registrado' });
    }

    const result = await pool.query(
      'INSERT INTO usuario (nombre, correo, contraseña, telefono, foto) VALUES ($1, $2, $3, $4, $5) RETURNING id_usuario, nombre, correo',
      [nombre, correo, contraseña, telefono, foto]
    );
    
    res.status(201).json({ 
      mensaje: 'Usuario registrado correctamente',
      usuario: result.rows[0]
    });
  } catch (error) {
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ error: 'Error en el servidorrr' });
  }
});

// Guardar temporalmente los códigos de recuperación
const codigosReset = new Map();

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

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Soporte Ruedas" <${process.env.EMAIL_USER}>`,
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

// 🔄 Restablecer contraseña
app.post("/restablecer-contrasena", async (req, res) => {
  const { correo, codigo, nuevaContraseña } = req.body;
  const codigoGuardado = codigosReset.get(correo);

  if (!codigoGuardado || codigoGuardado !== codigo) {
    return res.status(400).json({ mensaje: "Código incorrecto o expirado" });
  }

  try {
    // Guardar la contraseña tal cual, sin encriptarla
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
        cv.ID_usuario,
        u.nombre as nombre_vendedor,
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


// Publicar artículo con múltiples fotos
// Publicar artículo con múltiples fotos
app.post('/publicar_articulo', async (req: Request, res: Response) => {
  const { 
    nombre_Articulo, 
    descripcion, 
    precio, 
    tipo_bicicleta, 
    tipo_componente, 
    fotos,        // array de fotos en base64
    ID_usuario 
  } = req.body;

  if (!ID_usuario) {
    return res.status(400).json({ error: 'ID de usuario es requerido' });
  }

  if (!fotos || !Array.isArray(fotos) || fotos.length === 0) {
    return res.status(400).json({ error: 'Se requiere al menos una foto' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insertar publicación
    const result = await client.query(
      `INSERT INTO com_ventas 
        (nombre_Articulo, descripcion, precio, tipo_bicicleta, tipo_componente, ID_usuario) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING ID_publicacion`,
      [nombre_Articulo, descripcion, precio, tipo_bicicleta, tipo_componente, ID_usuario]
    );

    const idPublicacion = result.rows[0].id_publicacion;

    // Subir fotos al bucket y guardar URLs
    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];

      // Convertir base64 a buffer
      const base64Data = foto.replace(/^data:image\/\w+;base64,/, "");
      const fotoBuffer = Buffer.from(base64Data, 'base64');

      // Subir al bucket 'articulos'
      const { error: uploadError } = await supabase.storage
        .from('articulos')
        .upload(`publicaciones/${idPublicacion}/foto_${i}.png`, fotoBuffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) throw uploadError;

      // Obtener URL pública correctamente
      const { data } = supabase.storage
        .from('articulos')
        .getPublicUrl(`publicaciones/${idPublicacion}/foto_${i}.png`);

      const publicUrl = data.publicUrl;

      // Guardar URL en la tabla
      await client.query(
        `INSERT INTO com_ventas_fotos (ID_publicacion, url_foto) VALUES ($1, $2)`,
        [idPublicacion, publicUrl]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ 
      mensaje: 'Artículo publicado con éxito',
      ID_publicacion: idPublicacion
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al publicar artículo:', error);
    res.status(500).json({ error: 'Error al publicar el artículo' });
  } finally {
    client.release();
  }
});


// Guardar token de notificación en BD
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
      "INSERT INTO user_tokens (ID_usuario, token) VALUES ($1, $2) ON CONFLICT (token) DO NOTHING",
      [ID_usuario, token]
    );

    res.json({ message: "Token guardado correctamente" });
  } catch (error) {
    console.error("Error guardando token:", error);
    res.status(500).json({ error: "Error guardando token" });
  }
});

// Enviar notificación de prueba a un usuario
app.post("/test-notification", async (req: Request, res: Response) => {
  try {
    const { ID_usuario, token } = req.body;

    if (!ID_usuario) {
      return res.status(400).json({ error: "Falta ID_usuario" });
    }

     let tokens: string[] = [];
    if (token) {
      tokens = [token];
    } else {
      const result = await pool.query(
        "SELECT token FROM user_tokens WHERE ID_usuario = $1",
        [ID_usuario]
      );
      tokens = result.rows.map((row) => row.token);
    }

    if (tokens.length === 0) {
      return res
        .status(404)
        .json({ error: "No hay tokens registrados para este usuario" });
    }

    // Enviar notificaciones
    await Promise.all(
      tokens.map((t) =>
        axios.post("https://exp.host/--/api/v2/push/send", {
          to: t,
          sound: "default",
          title: "🚀 Notificación de prueba",
          body: "Este es un mensaje de prueba desde el backend",
        })
      )
    );

    res.json({ success: true, message: "Notificación enviada" });
  } catch (error) {
    console.error("Error enviando notificación:", error);
    res.status(500).json({ error: "Error enviando notificación" });
  }
});






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
      `SELECT u.id_usuario, u.nombre
       FROM com_ventas cv
       JOIN usuario u ON cv.id_usuario = u.id_usuario
       WHERE cv.id_publicacion = $1`,
      [ID_publicacion]
    );

    const vendedor = datosVendedor.rows[0];
    if (vendedor) {
      console.log("👨‍💼 Vendedor encontrado:", vendedor);

      // Obtener tokens
      const tokens = await pool.query(
        "SELECT token FROM user_tokens WHERE ID_usuario = $1",
        [vendedor.id_usuario]
      );

      console.log("🔑 Tokens del vendedor:", tokens.rows);

      if (tokens.rows.length > 0) {
        const mensajes = tokens.rows.map((t: any) => ({
          to: t.token,
          sound: "default",
          title: "¡Nuevo interés en tu artículo!",
          body: "Un usuario agregó tu artículo al carrito 🚀",
        }));

        // Enviar notificaciones en chunks
        const chunks = expo.chunkPushNotifications(mensajes);

        for (const chunk of chunks) {
          try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            console.log("🎫 Respuesta de Expo:", tickets);
          } catch (err) {
            console.error("❌ Error al enviar notificación:", err);
          }
        }

        console.log("📩 Notificación enviada al vendedor:", vendedor.nombre);
      } else {
        console.log("⚠️ El vendedor no tiene tokens registrados.");
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
    const compradoresIds = compradoresRes.rows.map((r: any) => r.id_usuario);
    let tokensRows: { id_usuario: number; token: string }[] = [];
    if (compradoresIds.length > 0) {
      const tokensRes = await pool.query(
        `SELECT ID_usuario, token FROM user_tokens WHERE ID_usuario = ANY($1::int[])`,
        [compradoresIds]
      );
      tokensRows = tokensRes.rows;
    }
    console.log('🔑 Tokens encontrados para compradores:', tokensRows);

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
    if (tokensRows.length > 0) {
      // enviar en paralelo (Promise.all), registrar respuestas
      const results = await Promise.all(tokensRows.map(async (r) => {
        try {
          const payload = {
            to: r.token,
            sound: 'default',
            title: 'Artículo ya no disponible ❌',
            body: `El artículo "${nombreArticulo}" que tenías en tu carrito ya fue vendido.`,
            data: { ID_publicacion: idPublicacion },
          };
          const resp = await axios.post('https://exp.host/--/api/v2/push/send', payload, { timeout: 10000 });
          console.log(`📩 Enviado a ${r.id_usuario} token:${r.token} -> status ${resp.status}`);
          return { ok: true, id_usuario: r.id_usuario, token: r.token, resp: resp.data };
        } catch (err: any) {
          console.error('❌ Error enviando notificación a token:', r.token, err?.response?.data ?? err.message);
          // si la API devuelve que el dispositivo no está registrado, eliminamos token
          const errData = err?.response?.data;
          // Expo si falla con token devuelve error en cuerpo; si ves DeviceNotRegistered en resp -> eliminar
          if (errData && typeof errData === 'object' && JSON.stringify(errData).includes('DeviceNotRegistered')) {
            await pool.query('DELETE FROM user_tokens WHERE token = $1', [r.token]).catch(e => console.error('Error eliminando token inválido:', e));
            console.log('🚮 Token eliminado por DeviceNotRegistered:', r.token);
          }
          return { ok: false, id_usuario: r.id_usuario, token: r.token, error: err?.message ?? err };
        }
      }));

      console.log('✅ Resultados envío notificaciones:', results);

      // 5) guardar notificaciones en BD
      for (const comprador of compradoresRes.rows) {
        try {
          await pool.query(
            `INSERT INTO notificaciones (id_usuario, titulo, cuerpo)
             VALUES ($1, $2, $3)`,
            [
              comprador.id_usuario,
              'Artículo ya no disponible ❌',
              `El artículo "${nombreArticulo}" que tenías en tu carrito ya fue vendido.`,
            ]
          );
        } catch (insertErr) {
          console.error('❌ Error guardando notificación en BD para usuario', comprador.id_usuario, insertErr);
        }
      }
    } else {
      console.log('⚠️ No se encontraron tokens para notificar a compradores.');
    }

    return res.json({
      message: 'Publicación eliminada, compradores notificados (si tenían token) y carrito limpiado',
      deleted: publicacion,
    });
  } catch (error) {
    console.error('❌ Error en /marcar-vendido:', error);
    return res.status(500).json({ error: 'Error en el servidor' });
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
      GROUP BY cv.ID_publicacion, u.nombre, u.telefono, u.foto, cv.nombre_Articulo, cv.descripcion, cv.precio, cv.tipo_bicicleta, cv.tipo_componente
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

