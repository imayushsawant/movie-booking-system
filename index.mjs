//  CREATE TABLE seats (
//      id SERIAL PRIMARY KEY,
//      name VARCHAR(255),
//      isbooked INT DEFAULT 0
//  );
// INSERT INTO seats (isbooked)
// SELECT 0 FROM generate_series(1, 20);

import express from "express";
import pg from "pg";
import { dirname } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import Joi from "joi";
import jwt from "jsonwebtoken"
import dotenv from "dotenv";
dotenv.config();

const SECRET = process.env.JWT_SECRET

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = process.env.PORT || 8080;

// Equivalent to mongoose connection
// Pool is nothing but group of connections
// If you pick one connection out of the pool and release it
// the pooler will keep that connection open for sometime to other clients to reuse
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const initDB = async () => {
  try {
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS seats (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        isbooked INT DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        first_name VARCHAR(50),
        last_name VARCHAR(50),
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255)
      );
    `);

    // Check if seats already exist
    const result = await pool.query(`SELECT COUNT(*) FROM seats`);
    const count = parseInt(result.rows[0].count);

    // Insert only if empty
    if (count === 0) {
      await pool.query(`
        INSERT INTO seats (name, isbooked)
        SELECT 'Seat ' || generate_series(1, 20), 0;
      `);
      console.log("Inserted 20 seats");
    } else {
      console.log("Seats already exist, skipping insert");
    }

  } catch (err) {
    console.error("DB init failed:", err);
  }
};


const app = new express();

app.use(express.json());
app.use(cors());

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/register.html");
});

app.use(express.static("public"));
//joi schema to validate the input
const registerschema = Joi.object({
  first_name: Joi.string().trim().min(2).max(50).required(),
  last_name: Joi.string().trim().min(2).max(50).required(),
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(8).max(50).required().pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/).messages({
    "string.pattern.base": "Password must contain uppercase, lowercase and number"
  })
})
const loginschema = Joi.object({
  email: Joi.string().email().max(254).required(),
  password: Joi.string().min(8).max(50).required().pattern(/^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/).messages({
    "string.pattern.base": "Password must contain uppercase, lowercase and number"
  })
})

// authenticate middleware
const authenticate = async (req, res, next) => {
  let token
  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1]
  }
  if (!token) return res.status(401).send({ message: "Not authrorized / no token" })
  try {
    const decode = jwt.verify(token, SECRET) 
    const userquery = "select * from users where email=$1"
    const result = await pool.query(userquery, [decode.email])
    const user = result.rows[0]
    if (!user) return res.status(400).send({ message: "user does not exist" })
    req.user = user
    next()
  }
  catch (err) {
    console.log(err);
    res.status(500).send({ message: "token is invalid" });
  }

}
// get me
app.get("/get-me", authenticate, (req, res) => {
  const user = req.user
  return res.status(200).send({ user })
})

//get all seats
app.get("/seats", async (req, res) => {
  const result = await pool.query("select * from seats"); // equivalent to Seats.find() in mongoose
  res.send(result.rows);
});

//registering the user
app.post("/register", async (req, res) => {
  try {
    const { error, value } = registerschema.validate(req.body)
    if (error) {
      return res.status(400).send({ error: error.details[0].message });
    }
    const { first_name, last_name, email, password } = value
    const emailcheck = "SELECT * FROM users WHERE email = $1"
    console.log("Validated:", value);
    const resultEmailCheck = await pool.query(emailcheck, [email])
    if (resultEmailCheck.rows.length > 0) return res.status(400).send({ error: "Email already exists" });
    const create_account = "INSERT INTO users (first_name, last_name, email, password) VALUES($1, $2, $3, $4)"
    await pool.query(create_account, [first_name, last_name, email, password])
    console.log("INSERT QUERY RAN");
    const result = await pool.query(emailcheck, [email])
    const user = result.rows[0]
    const access_token = jwt.sign({
        id:user.id,
        email:user.email
      }, SECRET, {
        expiresIn: '6h'
      })
    res.status(201).send({ message: "Successfully created an account", access_token});
  }
  catch (err) {
    console.log(err);
    res.status(500).send({ message: "Server failed" });
  }

})

// login
app.post("/login", async (req, res) => {
  try {
    const { error, value } = loginschema.validate(req.body)
    if (error) {
      return res.status(400).send({ error: error.details[0].message });
    }
    const { email, password } = value

    const emailcheck = "SELECT * FROM users WHERE email = $1"
    const result = await pool.query(emailcheck, [email])
    if (result.rows.length === 0) return res.status(400).send({ error: "User does not exists" });
    const user = result.rows[0]

    if (password === user.password) { 
      const access_token = jwt.sign({
        id:user.id,
        email:user.email
      }, SECRET, {
        expiresIn: '6h'
      })
      console.log("Login successful")
      return res.status(201).send({ access_token });
    }
    else {
      return res.status(400).send({ error: "Email or password is incorrect" });
    }

  } catch (error) {
    console.log(error)
    res.status(500).send({ message: "Server failed" })
  }

})

//book a seat give the seatId and your name

app.put("/:id/", authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    const user_id = req.user.id;
    // payment integration should be here 
    // verify payment
    const conn = await pool.connect(); // pick a connection from the pool
    //begin transaction
    // KEEP THE TRANSACTION AS SMALL AS POSSIBLE
    await conn.query("BEGIN");
    //getting the row to make sure it is not booked
    /// $1 is a variable which we are passing in the array as the second parameter of query function,
    // Why do we use $1? -> this is to avoid SQL INJECTION
    // (If you do ${id} directly in the query string,
    // then it can be manipulated by the user to execute malicious SQL code)
    const sql = "SELECT * FROM seats where id = $1 and isbooked = 0 FOR UPDATE";
    const result = await conn.query(sql, [id]);

    //if no rows found then the operation should fail can't book
    // This shows we Do not have the current seat available for booking
    if (result.rowCount === 0) {
      res.send({ error: "Seat already booked" });
      return;
    }
    //if we get the row, we are safe to update
    const sqlU = "update seats set isbooked = 1, user_id = $2 where id = $1";
    const updateResult = await conn.query(sqlU, [id, user_id]); // Again to avoid SQL INJECTION we are using $1 and $2 as placeholders

    //end transaction by committing
    await conn.query("COMMIT");
    conn.release(); // release the connection back to the pool (so we do not keep the connection open unnecessarily)
    res.send(updateResult);
  } catch (ex) {
    console.log(ex);
    res.send(500);
  }
});

initDB().then(() => {
  app.listen(port, () => console.log("Server running on port: " + port));
});
