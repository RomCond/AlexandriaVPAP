"""Writes the .xlsx files the unit tests read, each made by a different program.

Run from the repository root: python3 tests/fixtures/make-xlsx-fixtures.py
Needs xlsxwriter, openpyxl and LibreOffice (soffice). The tests only read the files it writes.
"""
import datetime
import os
import shutil
import subprocess
import tempfile
import zipfile

import openpyxl
import xlsxwriter

HERE = os.path.dirname(os.path.abspath(__file__))


def xlsxwriter_file():
    book = xlsxwriter.Workbook(os.path.join(HERE, 'records-xlsxwriter.xlsx'))
    sheet = book.add_worksheet('Records')
    date = book.add_format({'num_format': 'd mmm yyyy'})
    bold = book.add_format({'bold': True})
    wrap = book.add_format({'text_wrap': True})
    sheet.write_row(0, 0, ['Artist', 'Album', 'Year', 'Format', 'Label', 'Notes'])
    sheet.write_row(1, 0, ['Steely Dan', 'Aja'])
    sheet.write_datetime(1, 2, datetime.datetime(1977, 9, 23), date)
    sheet.write_row(1, 3, ['LP', 'ABC'])
    sheet.write_row(2, 0, ['Motörhead', 'Ace of Spades (Signed)', 1980, '7"', 'Bronze'])
    sheet.write_row(3, 0, ['Crosby, Stills & Nash', 'Crosby, Stills & Nash', 1969, 'LP', 'Atlantic'])
    sheet.write_string(3, 5, 'Gatefold\nfirst press', wrap)
    sheet.write_row(4, 0, ['Björk', 'Post', 1995, 'CD'])
    sheet.write_row(6, 0, ['Rush', 'Moving Pictures', 1981, '2xLP'])
    sheet.write(7, 0, 'Weezer')
    sheet.write_rich_string(7, 1, bold, 'Pink', 'erton')
    sheet.write_row(7, 2, [1996, 'LP'])
    other = book.add_worksheet('Wishlist')
    other.write_row(0, 0, ['Artist', 'Album'])
    other.write_row(1, 0, ['Portishead', 'Third'])
    book.close()


def xlsxwriter_gaps_file():
    # An empty cell in the middle of a row, and a number format with quoted text that has a d in it.
    book = xlsxwriter.Workbook(os.path.join(HERE, 'records-xlsxwriter-gaps.xlsx'))
    sheet = book.add_worksheet()
    era = book.add_format({'num_format': '0 "AD"'})
    sheet.write_row(0, 0, ['Artist', 'Album', 'Year', 'Format'])
    sheet.write_row(1, 0, ['Portishead', 'Portishead'])
    sheet.write(1, 3, 'LP')
    sheet.write_row(2, 0, ['Steely Dan', 'Gaucho'])
    sheet.write_number(2, 2, 1980, era)
    sheet.write(2, 3, 'LP')
    book.close()


def openpyxl_1904_file():
    book = openpyxl.Workbook()
    book.epoch = openpyxl.utils.datetime.CALENDAR_MAC_1904
    sheet = book.active
    sheet.title = 'Vinyl'
    sheet.append(['Band', 'Title', 'Released'])
    sheet.append(['Pink Floyd', 'The Dark Side of the Moon', datetime.datetime(1973, 3, 1)])
    sheet['C2'].number_format = 'yyyy-mm-dd'
    book.save(os.path.join(HERE, 'records-openpyxl-1904.xlsx'))


def libreoffice_file():
    work = tempfile.mkdtemp()
    try:
        csv = os.path.join(work, 'records-libreoffice.csv')
        with open(csv, 'w', encoding='utf-8') as out:
            out.write('Artist,Album,Release Date\nPortishead,Dummy,1994-08-22\nRadiohead,Kid A,2000\n')
        subprocess.run(['soffice', '--headless', '--convert-to', 'xlsx', '--outdir', work, csv], check=True, capture_output=True)
        shutil.copy(os.path.join(work, 'records-libreoffice.xlsx'), HERE)
    finally:
        shutil.rmtree(work)


def numbers_like_file():
    # A Numbers file is a zip archive too, with no Excel workbook inside.
    with zipfile.ZipFile(os.path.join(HERE, 'records.numbers'), 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('Index/Document.iwa', b'\x00' * 64)


xlsxwriter_file()
xlsxwriter_gaps_file()
openpyxl_1904_file()
libreoffice_file()
numbers_like_file()
print('wrote', sorted(name for name in os.listdir(HERE) if not name.endswith('.py')))
