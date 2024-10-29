const express = require("express");
const ejs = require("ejs");
const puppeteer = require("puppeteer");
const moment = require("moment");
const aws = require("aws-sdk");
const axios = require("axios");
const path = require("path");
const { Resend } = require("resend");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

aws.config = new aws.Config({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_ACCESS_SECRET,
});

const s3 = new aws.S3();
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();

app.use(cors());

// Body parser middleware
app.use(
  bodyParser.json({
    strict: true,
    verify: (req, res, buf) => {
      try {
        JSON.parse(buf);
      } catch (e) {
        res.status(400).send("Invalid JSON");
        throw new Error("Invalid JSON");
      }
    },
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

// Helper function to generate PDF as a stream
const generatePdfStream = async (templatePath, data) => {
  try {
    const html = await ejs.renderFile(templatePath, data);
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath: process.env.CHROME_BIN || puppeteer.executablePath(),
      headless: true,
      defaultViewport: null, // Garante a renderização completa
    });
    const page = await browser.newPage();
    await page.setViewport({
      width: 720,
      height: 385,
    });
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Opção para garantir a impressão do background
    const pdfBuffer = await page.pdf({
      width: "720px", // Largura exata do PDF
      height: "385px", // Altura exata do PDF
      printBackground: true, // Garante a impressão do background
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    });

    await browser.close();
    return pdfBuffer;
  } catch (error) {
    console.error("Erro ao gerar o PDF com Puppeteer: ", error);
    throw error;
  }
};

// Helper function to upload PDF to S3
const uploadToS3 = (buffer, id) => {
  return new Promise((resolve, reject) => {
    const params = {
      Key: `${id}.pdf`,
      Body: buffer,
      Bucket: "download.metricasboss.com.br/summit24",
      ContentType: "application/pdf",
    };
    s3.upload(params, (err, res) => {
      if (err) {
        console.error("Erro ao fazer upload para o S3: ", err);
        return reject(err);
      }
      resolve(res.Location);
    });
  });
};

// Helper function to send email using Resend
const sendEmail = async (email, attachmentUrl) => {
  try {
    const response = await axios.get(attachmentUrl, {
      responseType: "arraybuffer",
    });
    const attachmentContent = Buffer.from(response.data).toString("base64");

    await resend.emails.send({
      from: "prime@metricasboss.com.br",
      to: email,
      subject: `Agora sim, certificado Analytics Summit`,
      html: `
        <!DOCTYPE html>
          <html>
            <head>
              <meta charset="UTF-8">
              <title>Analytics Summit 2024 - Certificado de Participação</title>
              <style>body{font-family:Arial,sans-serif;line-height:1.6;margin:0;padding:0}h1{color:#333}p{color:#555}button{background-color:blue;color:#fff;padding:10px 20px;border:none;cursor:pointer}</style>
            </head>
            <body>
              <h1>O Analytics Summit 2024 foi incrível!</h1>
              <p>Obrigado pela sua participação!</p>
              <p>Neste e-mail está o seu certificado.</p>
              <p>Fique à vontade para compartilhar no Linkedin, Instagram e qualquer rede social.</p>
              <p>É só usar o <a href="${attachmentUrl}">link</a>.</p>
              <p>Não esquece de marcar a Métricas Boss, hein 😎</p>
              <p>Obs: Em breve, todas as palestras estarão disponíveis na Métricas Boss Prime.</p>
              <p>Até a próxima!</p>
            </body>
          </html>`,
      attachments: [
        {
          content: attachmentContent,
          filename: "certificate.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
      ],
    });
  } catch (error) {
    if (
      error.response &&
      error.response.data &&
      error.response.data.type === "Permanent" &&
      error.response.data.subtype === "On Account Suppression List"
    ) {
      console.error(
        "E-mail está na lista de supressão do Resend. Não foi possível enviar.",
        error.response.data
      );
    } else {
      console.error("Erro ao enviar o e-mail: ", error);
    }
    throw error;
  }
};

// Route to generate certificate
app.post("/generate", async (req, res) => {
  try {
    console.log("Recebido payload: ", req.body);
    const { payload, id } = req.body;
    if (!payload || !id) {
      return res
        .status(400)
        .json({ ok: false, error: "Payload ou ID faltando" });
    }

    const data = {
      name: payload["Nome completo"],
      email: payload["Seu e-mail"],
      date: moment().format("L"),
    };

    if (!data.name || !data.email) {
      return res
        .status(400)
        .json({ ok: false, error: "Nome ou e-mail faltando no payload" });
    }

    const certificateTemplate = path.join(__dirname, "view", "certificate.ejs");
    const pdfBuffer = await generatePdfStream(certificateTemplate, {
      name: data.name,
      date: data.date,
    });
    const attachmentUrl = await uploadToS3(pdfBuffer, id);
    await sendEmail(data.email, attachmentUrl);
    console.log("E-mail enviado com sucesso");
    return res.json({ ok: true, certificado: attachmentUrl });
  } catch (error) {
    console.error("Erro ao gerar o certificado: ", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Route to preview certificate
app.get("/preview", async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).send("Nome faltando para o preview");
    }

    const data = {
      name: name,
      date: moment().format("L"),
    };

    const certificateTemplate = path.join(__dirname, "view", "certificate.ejs");
    const html = await ejs.renderFile(certificateTemplate, {
      name: data.name,
      date: data.date,
    });
    res.type("text/html");
    res.send(html);
  } catch (error) {
    console.error("Erro ao renderizar o preview: ", error);
    res.status(500).send("Erro ao gerar o preview do certificado");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
