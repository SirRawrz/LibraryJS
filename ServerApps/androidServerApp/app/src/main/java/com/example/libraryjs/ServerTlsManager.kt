package com.example.libraryjs

import android.content.Context
import android.content.Intent
import android.security.KeyChain
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.asn1.x509.KeyPurposeId
import org.bouncycastle.asn1.x509.KeyUsage
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.Certificate
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import java.util.Calendar
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocketFactory

private const val KEYSTORE_PASSWORD = "libraryjs-https-password"

object ServerTlsManager {
    private const val DIRECTORY_NAME = "libraryjs_https"
    private const val CERT_FILE_NAME = "libraryjs-https-cert.pem"
    private const val CERT_DER_FILE_NAME = "libraryjs-https-cert.cer"
    private const val KEY_FILE_NAME = "libraryjs-https-key.pem"
    private const val KEY_SIZE = 2048
    private const val VALIDITY_YEARS = 25
    private const val RENEWAL_WINDOW_DAYS = 60

    fun ensureMaterial(context: Context, root: StorageRoot): HttpsMaterial {
        val directory = materialDirectory(context, root)
        if (!directory.exists()) directory.mkdirs()

        val certFile = File(directory, CERT_FILE_NAME)
        val certDerFile = File(directory, CERT_DER_FILE_NAME)
        val keyFile = File(directory, KEY_FILE_NAME)

        if (certFile.exists() && keyFile.exists()) {
            val existing = runCatching { loadMaterial(directory) }.getOrNull()
            if (existing != null && !isRenewalDue(existing.certificate)) {
                return existing
            }
        }

        return generateMaterial(directory, root)
    }

    fun hasSavedMaterial(context: Context, root: StorageRoot): Boolean {
        val directory = materialDirectory(context, root)
        return File(directory, CERT_FILE_NAME).exists() && File(directory, KEY_FILE_NAME).exists()
    }

    fun installCertificateIntent(context: Context, root: StorageRoot): Intent {
        val material = ensureMaterial(context, root)
        return KeyChain.createInstallIntent().apply {
            putExtra(KeyChain.EXTRA_CERTIFICATE, material.certificate.encoded)
            putExtra(KeyChain.EXTRA_NAME, "LibraryJS ${root.displayName.ifBlank { "Local Server" }}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    fun certificateStatusLine(context: Context, root: StorageRoot): String {
        val directory = materialDirectory(context, root)
        val certFile = File(directory, CERT_FILE_NAME)
        if (!certFile.exists()) {
            return "HTTPS cert will be generated when you install or start the server."
        }
        val certificate = runCatching { loadCertificate(certFile) }.getOrNull()
        return if (certificate != null) {
            "HTTPS cert saved locally. Tap Install HTTPS cert to trust it on this device."
        } else {
            "HTTPS cert files are present but could not be read."
        }
    }

    fun serverSocketFactory(context: Context, root: StorageRoot): SSLServerSocketFactory {
        val material = ensureMaterial(context, root)
        return material.serverSocketFactory()
    }

    private fun generateMaterial(directory: File, root: StorageRoot): HttpsMaterial {
        val keyPair = generateKeyPair()
        val certificate = generateCertificate(root, keyPair)
        val certificateDer = certificate.encoded
        val certFile = File(directory, CERT_FILE_NAME)
        val certDerFile = File(directory, CERT_DER_FILE_NAME)
        val keyFile = File(directory, KEY_FILE_NAME)

        certFile.writeText(toPem("CERTIFICATE", certificateDer), Charsets.UTF_8)
        certDerFile.writeBytes(certificateDer)
        keyFile.writeText(toPem("PRIVATE KEY", keyPair.private.encoded), Charsets.UTF_8)

        return HttpsMaterial(
            directory = directory,
            certificateFile = certFile,
            certificateDerFile = certDerFile,
            privateKeyFile = keyFile,
            certificate = certificate,
            privateKey = keyPair.private
        )
    }

    private fun loadMaterial(directory: File): HttpsMaterial {
        val certFile = File(directory, CERT_FILE_NAME)
        val certDerFile = File(directory, CERT_DER_FILE_NAME)
        val keyFile = File(directory, KEY_FILE_NAME)

        val certificate = loadCertificate(certFile)
        val privateKey = loadPrivateKey(keyFile)

        return HttpsMaterial(
            directory = directory,
            certificateFile = certFile,
            certificateDerFile = certDerFile,
            privateKeyFile = keyFile,
            certificate = certificate,
            privateKey = privateKey
        )
    }

    private fun loadCertificate(file: File): X509Certificate {
        val bytes = if (file.extension.equals("pem", ignoreCase = true)) {
            readPemBytes(file.readText(Charsets.UTF_8))
        } else {
            file.readBytes()
        }
        val factory = CertificateFactory.getInstance("X.509")
        return factory.generateCertificate(bytes.inputStream()) as X509Certificate
    }

    private fun loadPrivateKey(file: File): PrivateKey {
        val keyBytes = readPemBytes(file.readText(Charsets.UTF_8))
        val spec = PKCS8EncodedKeySpec(keyBytes)
        return KeyFactory.getInstance("RSA").generatePrivate(spec)
    }

    private fun generateKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("RSA")
        generator.initialize(KEY_SIZE, SecureRandom())
        return generator.generateKeyPair()
    }

    private fun generateCertificate(root: StorageRoot, keyPair: KeyPair): X509Certificate {
        val now = Date()
        val end = Calendar.getInstance().apply {
            time = now
            add(Calendar.YEAR, VALIDITY_YEARS)
        }.time
        val subject = X500Name("CN=LibraryJS ${root.displayName.ifBlank { "Local Server" }}")
        val serial = BigInteger.valueOf(System.currentTimeMillis()).abs().add(BigInteger.ONE)

        val builder = JcaX509v3CertificateBuilder(
            subject,
            serial,
            now,
            end,
            subject,
            keyPair.public
        )

        builder.addExtension(Extension.basicConstraints, true, BasicConstraints(true))
        builder.addExtension(
            Extension.keyUsage,
            true,
            KeyUsage(
                KeyUsage.digitalSignature or
                    KeyUsage.keyEncipherment or
                    KeyUsage.keyCertSign or
                    KeyUsage.cRLSign
            )
        )
        builder.addExtension(
            Extension.extendedKeyUsage,
            false,
            org.bouncycastle.asn1.x509.ExtendedKeyUsage(KeyPurposeId.id_kp_serverAuth)
        )

        val altNames = buildSubjectAltNames()
        if (altNames != null) {
            builder.addExtension(Extension.subjectAlternativeName, false, altNames)
        }

        val signer = JcaContentSignerBuilder("SHA256withRSA").build(keyPair.private)
        val certificate = JcaX509CertificateConverter().getCertificate(builder.build(signer))
        certificate.verify(keyPair.public)
        return certificate
    }

    private fun buildSubjectAltNames(): GeneralNames? {
        val names = mutableListOf<GeneralName>()
        names += GeneralName(GeneralName.dNSName, "localhost")
        names += GeneralName(GeneralName.iPAddress, "127.0.0.1")
        names += GeneralName(GeneralName.iPAddress, "::1")
        NetworkUtils.preferredLocalIPv4()?.let { ip ->
            names += GeneralName(GeneralName.iPAddress, ip)
        }
        return if (names.isEmpty()) null else GeneralNames(names.toTypedArray())
    }

    private fun isRenewalDue(certificate: X509Certificate): Boolean {
        val now = System.currentTimeMillis()
        val thresholdMillis = now + (RENEWAL_WINDOW_DAYS.toLong() * 24L * 60L * 60L * 1000L)
        return certificate.notAfter.time <= thresholdMillis
    }

    private fun materialDirectory(context: Context, root: StorageRoot): File {
        return File(File(context.filesDir, DIRECTORY_NAME), sanitizeFileName(root.id))
    }

    private fun sanitizeFileName(input: String): String {
        return input.trim().ifBlank { "root" }.replace(Regex("[^a-zA-Z0-9._-]+"), "_")
    }

    private fun toPem(type: String, bytes: ByteArray): String {
        val base64 = Base64.getMimeEncoder(64, "\n".toByteArray(Charsets.US_ASCII)).encodeToString(bytes)
        return buildString {
            append("-----BEGIN ")
            append(type)
            append("-----\n")
            append(base64)
            append("\n-----END ")
            append(type)
            append("-----\n")
        }
    }

    private fun readPemBytes(text: String): ByteArray {
        val trimmed = text
            .lineSequence()
            .filterNot { it.startsWith("-----BEGIN ") || it.startsWith("-----END ") }
            .joinToString("")
            .replace("\n", "")
            .replace("\r", "")
            .trim()
        return Base64.getDecoder().decode(trimmed)
    }
}

data class HttpsMaterial(
    val directory: File,
    val certificateFile: File,
    val certificateDerFile: File,
    val privateKeyFile: File,
    val certificate: X509Certificate,
    val privateKey: PrivateKey
) {
    fun serverSocketFactory(): SSLServerSocketFactory {
        val keyStore = KeyStore.getInstance("PKCS12").apply { load(null, null) }
        val password = KEYSTORE_PASSWORD.toCharArray()
        keyStore.setKeyEntry("libraryjs_https", privateKey, password, arrayOf<Certificate>(certificate))
        val keyManagerFactory = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
            init(keyStore, password)
        }
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(keyManagerFactory.keyManagers, null, SecureRandom())
        }
        return sslContext.serverSocketFactory as SSLServerSocketFactory
    }
}
