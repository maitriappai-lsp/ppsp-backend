// ---------------------------------------------------------------------------
// Seeds the database with the exact same demo data as the client's
// src/data/mockData.js, so the app behaves identically on first run whether
// it's talking to the mock layer or this real backend.
//
// Run with: npm run seed   (after `npm run migrate`)
// ---------------------------------------------------------------------------
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

async function seed() {
  const hash = await bcrypt.hash('changeme123', 10);

  await pool.query('BEGIN');
  try {
    await pool.query(`
      INSERT INTO resources (id, name, phone, email, address, type, role, blood_group, emergency_contact, contract_start, contract_end, facial_data_captured, password_hash, must_change_password)
      VALUES
        ('R-001', 'Divya Shankar', '9840012345', 'divya.shankar@example.org', 'Alwarpet, Chennai', 'Volunteer', 'Facilitator', 'O+', '9840099999', '2026-06-01', '2027-05-31', TRUE, $1, FALSE),
        ('R-023', 'Karthik Raman', '9840023456', 'karthik.raman@example.org', 'Anna Nagar, Chennai', 'Honorary Staff', 'Facilitator', 'B+', '9840088888', '2026-04-01', '2027-03-31', TRUE, $1, TRUE),
        ('R-002', 'Priya Menon', '9840034567', 'priya.menon@example.org', 'T. Nagar, Chennai', 'Staff', 'Admin', 'A+', '9840077777', '2025-01-01', '2028-12-31', FALSE, $1, FALSE)
      ON CONFLICT (id) DO NOTHING;
    `, [hash]);

    await pool.query(`
      INSERT INTO beneficiaries (id, school, class, section) VALUES
        ('EC-ALW-CL6-A', 'Alwarpet School', 'Class 6', 'A'),
        ('EC-ALW-CL6-B', 'Alwarpet School', 'Class 6', 'B'),
        ('EC-CAN-CL6-B', 'Canal Road School', 'Class 6', 'B'),
        ('EC-NSG-MIX-X', 'NS Garden', 'Mixed', 'X')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO categories (id, pillar, topic, subtopic) VALUES
        ('LSS-VE-OTH-000', 'Values', 'OTHERS', 'OTHERS'),
        ('LSS-EE-OTH-000', 'Environment', 'OTHERS', 'OTHERS'),
        ('LSS-HH-OTH-000', 'Health and Hygiene', 'OTHERS', 'OTHERS'),
        ('LSS-SS-CS-001', 'Soft Skills', 'Communication Skills', 'Empathy'),
        ('LSS-SS-CS-002', 'Soft Skills', 'Communication Skills', 'Body Language'),
        ('LSS-CR-OTH-000', 'Creativity', 'OTHERS', 'OTHERS')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO geo (id, school, lat, lng, radius_meters) VALUES
        ('GEO-ALW', 'Alwarpet School', 13.0343, 80.2545, 150),
        ('GEO-CAN', 'Canal Road School', 13.0500, 80.2121, 150),
        ('GEO-NSG', 'NS Garden', 13.0067, 80.2206, 150)
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO schedule (id, beneficiary_id, facilitator_id, date, time, category_id) VALUES
        ('SCH-0001', 'EC-ALW-CL6-A', 'R-001', '2026-09-18', '10:00', 'LSS-SS-CS-002'),
        ('SCH-0002', 'EC-CAN-CL6-B', 'R-023', '2026-09-19', '11:30', 'LSS-VE-OTH-000')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO psr (id, beneficiary_id, facilitator_id, date, time_in, time_out, category_id, students_present, rating, rag, facilitator_feedback, school_feedback, photos_uploaded) VALUES
        ('PSR-0001', 'EC-ALW-CL6-A', 'R-001', '2026-09-16', '10:02 AM', '10:58 AM', 'LSS-SS-CS-002', 28, 'Good', 'Amber', 'Good engagement, a few students shy to role-play.', 'Requested more sessions on this topic.', TRUE),
        ('PSR-0002', 'EC-CAN-CL6-B', 'R-023', '2026-09-12', '11:32 AM', '12:20 PM', 'LSS-SS-CS-001', 31, 'Excellent', 'Green', 'Empathy circle activity landed very well.', '', TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO uploads (id, file_name, beneficiary_id, category_id, facilitator_id, date, description) VALUES
        ('UPL-0001', 'session_alwarpet_16sep.jpg', 'EC-ALW-CL6-A', 'LSS-SS-CS-002', 'R-001', '2026-09-16', 'Role-play activity photo')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO content (id, title, category_id, file_type, uploaded_by, date) VALUES
        ('CNT-0001', 'Body Language Basics -- facilitator deck', 'LSS-SS-CS-002', 'PPT', 'R-002', '2026-09-01'),
        ('CNT-0002', 'Empathy circle activity guide', 'LSS-SS-CS-001', 'PDF', 'R-002', '2026-08-14')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO system_parameters (id, product_type, org_name, max_named_users, product_validity_end, login_by_email, gps_on_beneficiary, allowed_upload_types) VALUES
        (TRUE, 'Education', 'Maitri Trust', 999, '2027-05-31', FALSE, TRUE, '["photo","pdf","ppt"]')
      ON CONFLICT (id) DO NOTHING;
    `);

    await pool.query('COMMIT');
    console.log('Seed complete. Demo logins (password for all: changeme123):');
    console.log('  9840012345  Facilitator (Divya Shankar)');
    console.log('  9840023456  Facilitator, forces password change (Karthik Raman)');
    console.log('  9840034567  Programme Admin (Priya Menon)');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
